"""WorkBuddy 桥接的进程与数据管理。

职责
----
- 解析插件设置（端口、实例开关、node/Electron 路径、数据目录、自动同步策略）；
- 维护**机器级**数据目录（不是 profile 级）：桥接是固定端口上的本地单例服务，
  多个 profile/bot 共享同一实例；若每个 profile 各存一份配置，令牌会互相冲突。
- 首次运行迁移旧的 ``~/workbuddy-bridge`` 配置与模型缓存（令牌不变，行为不变）；
- 启动 / 停止 / 健康检查 node 桥接进程（无控制台窗口、日志落盘）；
- 从桥接配置读取本地 Bearer 令牌（只在本插件内部使用，绝不对外输出）。

设计要点
--------
- ``register()`` 期间不做任何网络或进程操作（``hermes plugins doctor`` 会校验）；
- 一切副作用都发生在工具调用 / CLI 命令 / ``on_session_start`` 钩子里；
- 启动用 ``DETACHED_PROCESS``，插件卸载或 Hermes 退出不会带走桥接，
  需要停止时用 ``hermes workbuddy stop``（按端口找 PID）。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
import hashlib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

PLUGIN_DIR = Path(__file__).resolve().parent.parent  # 仓库根目录（本包在 <root>/workbuddy/）
BRIDGE_DIR = PLUGIN_DIR / "bridge"
LEGACY_DIR = Path.home() / "workbuddy-bridge"

# 与 plugin.yaml 的 config_schema 保持一致；ctx 不可用时用这里的默认值
DEFAULTS: Dict[str, Any] = {
    "autostart": True,
    "auto_sync": True,
    "enable_cn": True,
    "enable_ai": True,
    "port_cn": 39621,
    "port_ai": 39622,
    "data_dir": "",
    "node_path": "",
    "electron_bin_cn": "",
    "electron_bin_ai": "",
    "probe_models": True,
    "sync_profiles": "",
}

START_TIMEOUT_S = 45.0
PROBE_WORKERS = 2
PROBE_RETRY_DELAY_S = 1.5
LOG_ROTATE_BYTES = 5 * 1024 * 1024
# 推理档位探测：非法哨兵值 + 规范档位（只声明被上游真正接受的）
EFFORT_SENTINEL = "__workbuddy_invalid__"
EFFORT_CANDIDATES = ("low", "high", "max")
EFFORT_CACHE_TTL_S = 7 * 86400


@dataclass(frozen=True)
class Instance:
    """一个桥接实例（一个 WorkBuddy 变体）。"""

    key: str            # workbuddy | workbuddy-ai（同时是 provider 名）
    variant: str        # 传给 server.mjs 的 variant
    port_key: str       # 插件设置里的端口键
    enable_key: str     # 插件设置里的开关键
    token_env: str      # 本地 Bearer 令牌写入的 .env 变量名
    electron_key: str   # 插件设置里的 Electron 路径键
    electron_env: str   # 传给子进程的 Electron 路径变量
    config_name: str    # 数据目录里的配置文件
    log_name: str       # 数据目录里的日志文件

    @property
    def label(self) -> str:
        return "WorkBuddy" if self.key == "workbuddy" else "WorkBuddy AI"


INSTANCES: tuple[Instance, ...] = (
    Instance(
        key="workbuddy",
        variant="workbuddy",
        port_key="port_cn",
        enable_key="enable_cn",
        token_env="WORKBUDDY_BRIDGE_TOKEN",
        electron_key="electron_bin_cn",
        electron_env="WORKBUDDY_ELECTRON_BIN",
        config_name="config.json",
        log_name="bridge.log",
    ),
    Instance(
        key="workbuddy-ai",
        variant="workbuddy-ai",
        port_key="port_ai",
        enable_key="enable_ai",
        token_env="WORKBUDDY_AI_BRIDGE_TOKEN",
        electron_key="electron_bin_ai",
        electron_env="WORKBUDDY_AI_ELECTRON_BIN",
        config_name="config.ai.json",
        log_name="bridge-ai.log",
    ),
)


class BridgeManager:
    """桥接实例的管理器（线程安全、懒启动）。"""

    def __init__(self, ctx: Any = None) -> None:
        self.ctx = ctx
        self._lock = threading.RLock()
        self._start_locks = {inst.key: threading.RLock() for inst in INSTANCES}
        self._last_error: Dict[str, str] = {}
        self._migrated = False
        self._node: Optional[str] = None

    # ─────────────────────────── 设置 ───────────────────────────

    def setting(self, key: str) -> Any:
        if self.ctx is not None:
            try:
                return self.ctx.get_config(key, default=DEFAULTS.get(key))
            except Exception:
                pass
        return DEFAULTS.get(key)

    def setting_bool(self, key: str) -> bool:
        return bool(self.setting(key))

    def setting_int(self, key: str) -> int:
        try:
            return int(self.setting(key))
        except (TypeError, ValueError):
            return int(DEFAULTS.get(key) or 0)

    def setting_str(self, key: str) -> str:
        value = self.setting(key)
        return str(value).strip() if value is not None else ""

    def instances(self) -> List[Instance]:
        return [inst for inst in INSTANCES if self.setting_bool(inst.enable_key)]

    def port(self, inst: Instance) -> int:
        port = self.setting_int(inst.port_key)
        return port if 1 <= port <= 65535 else int(DEFAULTS[inst.port_key])

    # ─────────────────────────── 路径 ───────────────────────────

    def data_dir(self) -> Path:
        override = self.setting_str("data_dir")
        if override:
            return Path(override).expanduser()
        env_override = os.environ.get("WORKBUDDY_BRIDGE_DATA", "").strip()
        if env_override:
            return Path(env_override).expanduser()
        if os.name == "nt":
            root = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
            return Path(root) / "hermes-workbuddy-bridge"
        return Path.home() / ".local" / "share" / "hermes-workbuddy-bridge"

    def state_dir(self) -> Path:
        return self.data_dir() / "state"

    def logs_dir(self) -> Path:
        return self.data_dir() / "logs"

    def config_path(self, inst: Instance) -> Path:
        return self.data_dir() / inst.config_name

    def log_path(self, inst: Instance) -> Path:
        return self.logs_dir() / inst.log_name

    def ensure_dirs(self) -> Path:
        data = self.data_dir()
        self.state_dir().mkdir(parents=True, exist_ok=True)
        self.logs_dir().mkdir(parents=True, exist_ok=True)
        with self._lock:
            if not self._migrated:
                self._migrate_legacy(data)
                self._migrated = True
        return data

    def _migrate_legacy(self, data: Path) -> None:
        """把旧 ``~/workbuddy-bridge`` 的配置/缓存搬过来（目标已存在则跳过）。"""
        try:
            if not LEGACY_DIR.is_dir():
                return
            for name in ("config.json", "config.ai.json"):
                src, dst = LEGACY_DIR / name, data / name
                if src.is_file() and not dst.exists():
                    shutil.copy2(src, dst)
            legacy_state = LEGACY_DIR / "state"
            if legacy_state.is_dir():
                for src in legacy_state.glob("catalog-cache-*.json"):
                    dst = self.state_dir() / src.name
                    if not dst.exists():
                        shutil.copy2(src, dst)
        except Exception:  # 迁移是尽力而为，失败不影响新目录
            pass

    # ─────────────────────────── node ───────────────────────────

    def node_path(self) -> str:
        if self._node:
            return self._node
        explicit = self.setting_str("node_path")
        candidates: List[str] = []
        if explicit:
            candidates.append(explicit)
        found = shutil.which("node")
        if found:
            candidates.append(found)
        local = os.environ.get("LOCALAPPDATA", "")
        if local:
            tools = Path(local) / "hermes" / "tools"
            if tools.is_dir():
                candidates.extend(str(p) for p in sorted(tools.glob("node-*/node.exe"), reverse=True))
        if os.name == "nt":
            candidates.append(r"C:\Program Files\nodejs\node.exe")
        else:
            candidates.extend(["/usr/local/bin/node", "/usr/bin/node"])
        for cand in candidates:
            try:
                if Path(cand).is_file():
                    self._node = str(cand)
                    return self._node
            except OSError:
                continue
        raise RuntimeError(
            "找不到 node：请安装 Node.js，或在插件设置（plugins.entries.workbuddy.settings.node_path）里指定 node 路径"
        )

    # ─────────────────────────── 配置 / HTTP ───────────────────────────

    def read_config(self, inst: Instance) -> Dict[str, Any]:
        path = self.config_path(inst)
        for _ in range(10):
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except (FileNotFoundError, json.JSONDecodeError):
                time.sleep(0.1)
        return {}

    def token(self, inst: Instance) -> str:
        token = self.read_config(inst).get("token")
        return token if isinstance(token, str) else ""

    def _prepare_config(self, inst: Instance, port: int) -> Path:
        """确保配置文件存在，且端口与当前设置一致（其余键原样保留）。

        历史缺陷：只在配置文件不存在时写 port，用户改端口后桥接仍监听旧端口，
        插件却轮询新端口 → 启动超时，或留下一个孤儿实例。
        """
        path = self.config_path(inst)
        data: Dict[str, Any] = {}
        if path.exists():
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    data = loaded
            except Exception:
                data = {}
        merged = {
            "catalogRefreshMinutes": 10,
            **data,
            "port": port,
            "variant": inst.variant,
        }
        if not path.exists() or merged != data:
            path.write_text(json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return path

    def is_port_open(self, port: int) -> bool:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.4)
            return sock.connect_ex(("127.0.0.1", port)) == 0

    def _http(self, inst: Instance, path: str, timeout: float = 5.0) -> tuple[int, Dict[str, Any]]:
        token = self.token(inst)
        if not token:
            raise RuntimeError("桥接尚未生成本地令牌（进程可能还没启动完成）")
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port(inst)}{path}",
            headers={"Authorization": f"Bearer {token}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", "replace")
                return resp.status, (json.loads(raw) if raw.strip() else {})
        except urllib.error.HTTPError as exc:
            raw = ""
            try:
                raw = exc.read().decode("utf-8", "replace")
            except Exception:
                pass
            try:
                return exc.code, json.loads(raw) if raw.strip() else {}
            except json.JSONDecodeError:
                return exc.code, {"error": raw[:300]}

    def health(self, inst: Instance) -> Dict[str, Any]:
        """桥接 /healthz 快照；任何异常都折叠成 {ok: False, error}。"""
        if not self.is_port_open(self.port(inst)):
            return {"ok": False, "error": "not running"}
        try:
            status, body = self._http(inst, "/healthz", timeout=3.0)
            if status == 200 and isinstance(body, dict):
                return body
            message = ""
            if isinstance(body, dict):
                err = body.get("error")
                message = err.get("message") if isinstance(err, dict) else str(err or "")
            return {"ok": False, "error": message or f"HTTP {status}"}
        except Exception as exc:  # 连接被拒 / 超时 / 令牌不匹配
            return {"ok": False, "error": str(exc)}

    def models(self, inst: Instance) -> List[Dict[str, Any]]:
        status, body = self._http(inst, "/v1/models", timeout=20.0)
        if status != 200 or not isinstance(body, dict):
            raise RuntimeError(f"{inst.key}: 读取模型列表失败（HTTP {status}）")
        rows = body.get("data")
        return [row for row in rows if isinstance(row, dict) and isinstance(row.get("id"), str)] if isinstance(rows, list) else []

    def credits(self, inst: Instance) -> Dict[str, Any]:
        status, body = self._http(inst, "/v1/credits", timeout=20.0)
        return body if status == 200 and isinstance(body, dict) else {"error": f"HTTP {status}"}

    # ─────────────────────────── 模型可用性探测 ───────────────────────────

    def probe_cache_path(self, inst: Instance) -> Path:
        return self.state_dir() / f"model-probe-{inst.key}.json"

    def _read_probe_cache(self, inst: Instance, fingerprint: str) -> Optional[Dict[str, str]]:
        try:
            data = json.loads(self.probe_cache_path(inst).read_text(encoding="utf-8"))
        except Exception:
            return None
        if data.get("fingerprint") != fingerprint:
            return None
        if time.time() - float(data.get("ts", 0)) > 6 * 3600:
            return None
        results = data.get("results")
        return results if isinstance(results, dict) else None

    def probe_models(self, inst: Instance, models: List[Dict[str, Any]], *, force: bool = False) -> Dict[str, str]:
        """探测每个模型是否被当前账号允许（上游 400/11158 = 不允许）。

        返回 ``{model_id: "ok" | "blocked" | "unknown"}``；结果按模型目录指纹缓存 6 小时。
        探测请求是 ``max_tokens=1`` 的最小对话（对免费模型零成本，付费模型约 1 token）。
        """
        fingerprint = hashlib.sha1(
            ",".join(sorted(row["id"] for row in models)).encode("utf-8")
        ).hexdigest()
        if not force:
            cached = self._read_probe_cache(inst, fingerprint)
            if cached is not None:
                return cached

        token = self.token(inst)
        port = self.port(inst)

        def probe_one(model_id: str) -> tuple[str, str]:
            body = json.dumps(
                {
                    "model": model_id,
                    "messages": [{"role": "user", "content": "ok"}],
                    "stream": False,
                    "max_tokens": 1,
                }
            ).encode("utf-8")
            req = urllib.request.Request(
                f"http://127.0.0.1:{port}/v1/chat/completions",
                data=body,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                method="POST",
            )
            # 上游偶发限流（429）：退避后重试一次；仍失败记为 unknown（"未验证"），
            # 不会当成可用，也不会把模型误判成无权限。
            for attempt in (1, 2):
                try:
                    with urllib.request.urlopen(req, timeout=60) as resp:
                        resp.read()
                        return model_id, "ok"
                except urllib.error.HTTPError as exc:
                    raw = ""
                    try:
                        raw = exc.read().decode("utf-8", "replace")
                    except Exception:
                        pass
                    if exc.code == 429 and attempt == 1:
                        time.sleep(PROBE_RETRY_DELAY_S)
                        continue
                    low = raw.lower()
                    if "11158" in low or "not allowed" in low:
                        return model_id, "blocked"
                    return model_id, "unknown"
                except Exception:
                    return model_id, "unknown"
            return model_id, "unknown"

        results: Dict[str, str] = {}
        # 并发压到 2：探测是真实对话请求，4 并发容易触发上游限流，把结果打成一片 unknown
        with ThreadPoolExecutor(max_workers=PROBE_WORKERS) as pool:
            for model_id, verdict in pool.map(probe_one, [row["id"] for row in models]):
                results[model_id] = verdict
        try:
            self.probe_cache_path(inst).write_text(
                json.dumps({"fingerprint": fingerprint, "ts": time.time(), "results": results},
                           ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        except Exception:
            pass
        return results

    # ─────────────────────────── 推理档位探测 ───────────────────────────
    # 上游对 `reasoning_effort` 的处理分两类：
    #   1) 完全不校验（非法值也 200）→ 声明档位只会得到"选了没用"的假开关，一律不声明；
    #   2) 会校验（非法值 400）→ 逐个测试规范档位，只保留被接受的。
    # 这与参考插件"先确认上游会校验该参数"的策略一致。

    def effort_cache_path(self, inst: Instance) -> Path:
        return self.state_dir() / f"effort-probe-{inst.key}.json"

    def _probe_chat(self, inst: Instance, model_id: str, effort: str) -> tuple[bool, int, str]:
        """发一次最小请求，返回 (是否被接受, HTTP 状态码, 响应正文)。"""
        body = json.dumps({
            "model": model_id,
            "messages": [{"role": "user", "content": "ok"}],
            "stream": False,
            "max_tokens": 1,
            "reasoning_effort": effort,
        }).encode("utf-8")
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port(inst)}/v1/chat/completions",
            data=body,
            headers={"Authorization": f"Bearer {self.token(inst)}", "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                resp.read()
                return True, 200, ""
        except urllib.error.HTTPError as exc:
            raw = ""
            try:
                raw = exc.read().decode("utf-8", "replace")
            except Exception:
                pass
            return False, exc.code, raw
        except Exception as exc:  # 网络/超时：当作未知，不声明
            return False, 0, str(exc)

    @staticmethod
    def classify_effort_response(accepted: bool, status: int) -> str:
        """把一次探测结果归类：accepted（接受档位）/ unsupported（不校验参数）/ rejected。"""
        if accepted:
            return "accepted"
        if status in (400, 422):
            return "rejected"
        return "unknown"

    def read_effort_cache(self, inst: Instance) -> Dict[str, List[str]]:
        """只读缓存（bundle 生成用）；没有就返回空。"""
        try:
            data = json.loads(self.effort_cache_path(inst).read_text(encoding="utf-8"))
        except Exception:
            return {}
        results = data.get("results")
        if not isinstance(results, dict):
            return {}
        return {str(k): [str(v) for v in values] for k, values in results.items() if isinstance(values, list)}

    def probe_efforts(self, inst: Instance, models: List[Dict[str, Any]], *, force: bool = False) -> Dict[str, List[str]]:
        """探测每个模型是否真正支持 `reasoning_effort`，返回 ``{model_id: [可用档位]}``。

        空列表 = 上游不校验该参数（或所有档位都被拒绝），调用方不应声明 reasoningEfforts。
        结果按模型目录指纹缓存 7 天。
        """
        fingerprint = hashlib.sha1(
            (EFFORT_SENTINEL + "|" + ",".join(sorted(row["id"] for row in models))).encode("utf-8")
        ).hexdigest()
        if not force:
            try:
                cached = json.loads(self.effort_cache_path(inst).read_text(encoding="utf-8"))
                if cached.get("fingerprint") == fingerprint and time.time() - float(cached.get("ts", 0)) < EFFORT_CACHE_TTL_S:
                    results = cached.get("results")
                    if isinstance(results, dict):
                        return {str(k): [str(v) for v in values] for k, values in results.items() if isinstance(values, list)}
            except Exception:
                pass

        def probe(model_id: str) -> tuple[str, List[str]]:
            accepted, status, _raw = self._probe_chat(inst, model_id, EFFORT_SENTINEL)
            verdict = self.classify_effort_response(accepted, status)
            if verdict != "rejected":
                # 不校验（accepted）或未知（网络错误）：都不声明，避免假档位
                return model_id, []
            supported: List[str] = []
            for effort in EFFORT_CANDIDATES:
                ok, _status, _body = self._probe_chat(inst, model_id, effort)
                if ok:
                    supported.append(effort)
            return model_id, supported

        results: Dict[str, List[str]] = {}
        with ThreadPoolExecutor(max_workers=PROBE_WORKERS) as pool:
            for model_id, efforts in pool.map(probe, [row["id"] for row in models]):
                results[model_id] = efforts
        try:
            self.effort_cache_path(inst).write_text(
                json.dumps({"fingerprint": fingerprint, "ts": time.time(), "results": results},
                           ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        except Exception:
            pass
        return results

    # ─────────────────────────── 启停 ───────────────────────────

    def _pids_on_port(self, port: int) -> List[int]:
        if os.name == "nt":
            try:
                proc = subprocess.run(
                    ["netstat", "-ano", "-p", "tcp"],
                    capture_output=True, timeout=20,
                )
                # Windows netstat 输出是本地代码页（中文为 GBK），按字节读再解码，避免 text=True 解码失败
                out = (proc.stdout or b"").decode("utf-8", "replace")
            except Exception:
                return []
            pids = set()
            for line in out.splitlines():
                if "LISTENING" not in line.upper():
                    continue
                if not re.search(rf":{port}\s", line):
                    continue
                parts = line.split()
                if parts and parts[-1].isdigit():
                    pids.add(int(parts[-1]))
            return sorted(pids)
        try:
            proc = subprocess.run(["lsof", "-ti", f"tcp:{port}"], capture_output=True, timeout=15)
            out = (proc.stdout or b"").decode("utf-8", "replace")
            return sorted({int(x) for x in out.split() if x.isdigit()})
        except Exception:
            return []

    def ensure(self, inst: Instance) -> Dict[str, Any]:
        """确保实例在跑；已在跑（即使未登录）则返回现状，不重复起进程。"""
        return self.start(inst)

    # ── 进程归属 ────────────────────────────────────────────
    # stop() 只结束"确认属于本插件"的进程：端口上可能是用户自己的服务，
    # 无条件 taskkill /F /T 会误杀。判定顺序：
    #   1) 用本地令牌访问 /healthz，返回 200 且 variant 匹配 → 确定是我们的桥接；
    #   2) 兜底：pidfile 记录的 pid 仍在监听，且进程映像名是 node。
    # 两者都不成立就拒绝结束并说明原因。

    def pid_path(self, inst: Instance) -> Path:
        return self.state_dir() / f"bridge-{inst.key}.pid"

    def _read_recorded_pid(self, inst: Instance) -> Optional[int]:
        try:
            data = json.loads(self.pid_path(inst).read_text(encoding="utf-8"))
            pid = int(data.get("pid") or 0)
            return pid if pid > 0 else None
        except Exception:
            return None

    def _write_recorded_pid(self, inst: Instance, pid: int) -> None:
        try:
            self.pid_path(inst).write_text(
                json.dumps({"pid": pid, "port": self.port(inst), "started_at": time.time()}, ensure_ascii=False),
                encoding="utf-8",
            )
        except Exception:
            pass

    def _clear_recorded_pid(self, inst: Instance) -> None:
        try:
            self.pid_path(inst).unlink()
        except Exception:
            pass

    def _owns_port(self, inst: Instance) -> bool:
        """端口上跑的是不是本插件的桥接（用本地令牌做身份验证）。"""
        status, body = (0, {})
        try:
            status, body = self._http(inst, "/healthz", timeout=3.0)
        except Exception:
            return False
        if status != 200 or not isinstance(body, dict):
            return False
        return str(body.get("variant") or "") == inst.variant

    @staticmethod
    def _process_name(pid: int) -> str:
        try:
            if os.name == "nt":
                proc = subprocess.run(
                    ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                    capture_output=True, timeout=10,
                )
                out = (proc.stdout or b"").decode("utf-8", "replace")
                first = out.splitlines()[0] if out.strip() else ""
                name = first.split(",")[0].strip().strip('"')
                return name.lower()
            proc = subprocess.run(["ps", "-p", str(pid), "-o", "comm="], capture_output=True, timeout=10)
            return (proc.stdout or b"").decode("utf-8", "replace").strip().lower()
        except Exception:
            return ""

    def start(self, inst: Instance, timeout: float = START_TIMEOUT_S) -> Dict[str, Any]:
        with self._start_locks[inst.key]:
            health = self.health(inst)
            if health.get("ok"):
                return {"ok": True, "already_running": True, "port": self.port(inst), "health": health}
            port = self.port(inst)
            if self.is_port_open(port):
                if self._owns_port(inst):
                    # 是我们的桥接，只是没登录/目录为空：不再起第二个实例
                    return {"ok": False, "already_running": True, "port": port, "health": health}
                raise RuntimeError(
                    f"{inst.label}: 端口 {port} 已被其他进程占用（不是本插件启动的桥接）"
                )
            self.ensure_dirs()
            node = self.node_path()
            cfg_path = self._prepare_config(inst, port)
            env = dict(os.environ)
            env["WORKBUDDY_BRIDGE_CONFIG"] = str(cfg_path)
            env["WORKBUDDY_BRIDGE_STATE"] = str(self.state_dir())
            # 端口以插件设置为准：配置文件里的旧值不再能压过设置
            env["WORKBUDDY_BRIDGE_PORT"] = str(port)
            electron = self.setting_str(inst.electron_key)
            if electron:
                env[inst.electron_env] = electron
            env.setdefault("WORKBUDDY_BRIDGE_LOG", inst.log_name)

            flags = 0
            if os.name == "nt":
                flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "DETACHED_PROCESS", 0)
            self._rotate_log(inst)
            log_file = open(self.log_path(inst), "ab")
            try:
                proc = subprocess.Popen(
                    [node, str(BRIDGE_DIR / "server.mjs")],
                    cwd=str(BRIDGE_DIR),
                    env=env,
                    stdin=subprocess.DEVNULL,
                    stdout=log_file,
                    stderr=subprocess.STDOUT,
                    creationflags=flags,
                    start_new_session=(os.name != "nt"),
                )
            finally:
                log_file.close()

            deadline = time.time() + timeout
            while time.time() < deadline:
                if proc.poll() is not None:
                    tail = self.logs_tail(inst, 25)
                    raise RuntimeError(
                        f"{inst.label}: 桥接进程启动即退出（exit={proc.returncode}）。日志末尾：\n{tail}"
                    )
                try:
                    status, body = self._http(inst, "/healthz", timeout=2.0)
                except Exception:
                    status, body = 0, {}
                if status == 200 and isinstance(body, dict):
                    self._write_recorded_pid(inst, proc.pid)
                    return {"ok": True, "started": True, "pid": proc.pid, "port": port, "health": body}
                time.sleep(0.4)
            raise RuntimeError(f"{inst.label}: 桥接启动超时（{int(timeout)}s）。日志末尾：\n{self.logs_tail(inst, 25)}")

    def stop(self, inst: Instance, timeout: float = 10.0) -> Dict[str, Any]:
        port = self.port(inst)
        pids = self._pids_on_port(port)
        if not pids:
            self._clear_recorded_pid(inst)
            return {"ok": True, "stopped": False, "reason": "not running", "port": port}

        recorded = self._read_recorded_pid(inst)
        trusted = self._owns_port(inst) or (
            recorded is not None and recorded in pids and self._process_name(recorded).startswith("node")
        )
        if not trusted:
            return {
                "ok": False,
                "stopped": False,
                "refused": True,
                "port": port,
                "pids": pids,
                "reason": (
                    f"端口 {port} 被进程 {', '.join(str(p) for p in pids)} 占用，"
                    "但无法确认它是本插件的桥接（/healthz 不匹配且无可信 pid 记录）；已拒绝结束，请自行处理。"
                ),
            }

        for pid in pids:
            try:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(pid), "/F", "/T"], capture_output=True, timeout=20)
                else:
                    os.kill(pid, 15)
            except Exception:
                pass
        deadline = time.time() + timeout
        while time.time() < deadline and self.is_port_open(port):
            time.sleep(0.2)
        stopped = not self.is_port_open(port)
        if stopped:
            self._clear_recorded_pid(inst)
        return {"ok": stopped, "stopped": True, "pids": pids, "port": port}

    # ─────────────────────────── 状态 ───────────────────────────

    def status(self, inst: Instance, include_credits: bool = False) -> Dict[str, Any]:
        enabled = self.setting_bool(inst.enable_key)
        port = self.port(inst)
        if not enabled:
            return {"instance": inst.key, "label": inst.label, "provider": inst.key, "enabled": False, "port": port}
        running = self.is_port_open(port)
        health = self.health(inst) if running else {"ok": False, "error": "not running"}
        result: Dict[str, Any] = {
            "instance": inst.key,
            "label": inst.label,
            "provider": inst.key,
            "enabled": True,
            "port": port,
            "running": running,
            "health": health,
            "data_dir": str(self.data_dir()),
        }
        if include_credits and running:
            try:
                result["credits"] = self.credits(inst)
            except Exception as exc:
                result["credits_error"] = str(exc)
        # 最近一次模型可用性探测的汇总（同步时写入缓存）
        try:
            cache = json.loads(self.probe_cache_path(inst).read_text(encoding="utf-8"))
            verdicts = cache.get("results") or {}
            if isinstance(verdicts, dict) and verdicts:
                result["model_probe"] = {
                    "ok": sum(1 for value in verdicts.values() if value == "ok"),
                    "blocked": sum(1 for value in verdicts.values() if value == "blocked"),
                    "unknown": sum(1 for value in verdicts.values() if value not in ("ok", "blocked")),
                }
        except Exception:
            pass
        if inst.key in self._last_error:
            result["last_error"] = self._last_error[inst.key]
        return result

    def logs_tail(self, inst: Instance, lines: int = 40) -> str:
        path = self.log_path(inst)
        try:
            data = path.read_text(encoding="utf-8", errors="replace").splitlines()
            return "\n".join(data[-max(1, int(lines)):])
        except Exception:
            return "(暂无日志)"

    def _rotate_log(self, inst: Instance) -> None:
        """启动前轮转一次：超过 5MB 就把旧日志挪到 `<name>.1`（只保留一份）。

        桥接是常驻进程，日志只追加不轮转；长期运行会把磁盘写满。
        """
        path = self.log_path(inst)
        try:
            if not path.is_file() or path.stat().st_size < LOG_ROTATE_BYTES:
                return
            backup = path.with_name(path.name + ".1")
            if backup.exists():
                backup.unlink()
            path.rename(backup)
        except Exception:
            pass  # 轮转失败不应该阻止启动

    # ─────────────────────────── 会话钩子 ───────────────────────────

    def session_bootstrap(self) -> None:
        """on_session_start 的后台任务：确保桥接在跑，模型目录变了就刷新 provider。"""
        for inst in self.instances():
            try:
                self.ensure(inst)
                self._last_error.pop(inst.key, None)
            except Exception as exc:
                self._last_error[inst.key] = str(exc)
        if self.setting_bool("auto_sync"):
            try:
                from . import providers_sync
                providers_sync.auto_sync(self)
            except Exception:
                pass
