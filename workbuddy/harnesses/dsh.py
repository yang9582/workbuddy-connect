"""DeepSeek Harness（DSH）适配器：把本机桥接注册成 DSH 的 OpenAI 兼容 provider。

架构（2.1 起）
-------------
旧实现直接改写 `~/.dsh/profiles/*/node_modules/dsh-workbuddy-connect/lib/*.js`，
给官方插件打国内版兼容补丁。这条路有两个结构性缺陷：

1. pnpm 把 `node_modules` 里的文件**硬链接**到全局内容寻址 store。原地 `write_text`
   会穿透硬链接改到 `%LOCALAPPDATA%\\pnpm\\store`，污染 store，并让 `pnpm` 的完整性
   校验失效；
2. 补丁依赖压缩产物里的精确字符串锚点，上游一次构建就静默失效。

新实现只在 profile 的 `cordis.patch.yml` 里追加一段受管配置：

- `llm-pi-ai.providers.workbuddy(-ai)`：指向 `http://127.0.0.1:<port>/v1`，
  `api: openai-completions`，令牌从 `WORKBUDDY_BRIDGE_TOKEN` 读取；
- `llm-workbuddy.disabled: true`：把官方插件的模型分组关掉，避免同一批模型出现两组
  （该条目只在该 profile 确实装了官方插件时才写）。

模型列表由桥接的 `/v1/models` 生成，写进配置（静态声明，避免启动时依赖桥接可达）。
令牌写进 `~/.dsh/.env`——DSH 启动时会把该文件加载进进程环境，pi-ai 的 `apiKeyEnv`
从这里取值。

DSH 重启后生效；`wbconnect dsh restore` 可把历史上被补丁改过的插件文件恢复为原版。
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional

from .base import HarnessAdapter

BEGIN = "# >>> workbuddy-connect (managed; wbconnect dsh) >>>"
END = "# <<< workbuddy-connect (managed) <<<"
MANAGED_MARKERS = (BEGIN, END)
PATCH_FILENAME = "cordis.patch.yml"
PLUGIN_PACKAGE = "dsh-workbuddy-connect"
# 我们自己的 DSH bundle 包（只含声明式 patch，没有可执行代码）
BUNDLE_PACKAGE = "workbuddy-connect"
BUNDLE_SUBDIR = Path("dsh") / BUNDLE_PACKAGE

# 与桥接 server.mjs 的 prepareChatBody / pi-ai 适配相关的兼容开关。
# 桥接是标准 OpenAI chat completions（max_tokens、system 角色、finish_reason），
# 不支持 store / developer 角色 / reasoning_effort / 流式 usage。
MODEL_COMPAT = {
    "supportsStore": False,
    "supportsDeveloperRole": False,
    "supportsReasoningEffort": False,
    "supportsUsageInStreaming": False,
    "supportsFinishReason": True,
    "maxTokensField": "max_tokens",
}

DISPLAY_NAMES = {"workbuddy": "WorkBuddy", "workbuddy-ai": "WorkBuddy AI"}


def _yaml_str(value: str) -> str:
    """YAML 单引号标量（内部单引号翻倍）。"""
    return "'" + str(value).replace("'", "''") + "'"


class DshAdapter(HarnessAdapter):
    name = "dsh"
    label = "DeepSeek Harness"
    note = "bundle 装进 DSH 插件页后由 DSH 管理；未装 bundle 时退回写 profile 的 cordis.patch.yml"

    # ── 路径 ────────────────────────────────────────────────
    @property
    def dsh_home(self) -> Path:
        env = str(self._env("DSH_HOME") or "").strip()
        return Path(env).expanduser() if env else Path.home() / ".dsh"

    @staticmethod
    def _env(key: str) -> str:
        import os

        return os.environ.get(key, "")

    def profiles(self) -> List[Path]:
        root = self.dsh_home / "profiles"
        if not root.is_dir():
            return []
        return [
            child for child in sorted(root.iterdir())
            if child.is_dir() and (child / PATCH_FILENAME).is_file()
        ]

    def _targets(self, spec: str = "") -> List[Path]:
        available = self.profiles()
        spec = (spec or "").strip()
        if not spec or spec.lower() == "all":
            return available
        wanted = [part.strip() for part in spec.split(",") if part.strip()]
        return [p for p in available if p.name in wanted]

    def plugin_dirs(self) -> List[Path]:
        return [
            child / "node_modules" / PLUGIN_PACKAGE
            for child in self.profiles()
            if (child / "node_modules" / PLUGIN_PACKAGE).is_dir()
        ]

    # ── 检测 / 状态 ─────────────────────────────────────────
    def detect(self) -> bool:
        return bool(self.profiles())

    def _read(self, path: Path) -> str:
        try:
            return path.read_text(encoding="utf-8")
        except Exception:
            return ""

    def _version(self, path: Path) -> str:
        try:
            return str(json.loads((path / "package.json").read_text(encoding="utf-8")).get("version", ""))
        except Exception:
            return ""

    def _legacy_patched(self, plugin_dir: Path) -> List[str]:
        """仍带旧补丁标记的文件（相对插件目录）。"""
        hits: List[str] = []
        for candidate in [plugin_dir / "lib" / "index.js", *sorted((plugin_dir / "lib").glob("host-heartbeat-*.js"))]:
            if candidate.is_file() and "wb-compat" in self._read(candidate):
                hits.append(str(candidate.relative_to(plugin_dir)))
        return hits

    def status(self) -> Dict[str, Any]:
        info = super().status()
        rows = []
        for profile in self.profiles():
            text = self._read(profile / PATCH_FILENAME)
            plugin = profile / "node_modules" / PLUGIN_PACKAGE
            rows.append({
                "profile": profile.name,
                "patch": str(profile / PATCH_FILENAME),
                "managed": BEGIN in text,
                "official_installed": plugin.is_dir(),
                "official_version": self._version(plugin) if plugin.is_dir() else "",
                "legacy_patched": self._legacy_patched(plugin) if plugin.is_dir() else [],
            })
        info.update({
            "home": str(self.dsh_home),
            "profiles": rows,
            "bundle": {
                "installed": self.bundle_installed(),
                "package": BUNDLE_PACKAGE,
                "path": str(self.bundle_dir()),
                "patch": str(self.bundle_dir() / PATCH_FILENAME),
            },
            "mode": "bundle" if self.bundle_installed() else ("profile-patch" if any(row["managed"] for row in rows) else "not-configured"),
            "configured": self.bundle_installed() or any(row["managed"] for row in rows),
            "legacy_patched": [f"{row['profile']}:{p}" for row in rows for p in row["legacy_patched"]],
        })
        return info

    # ── 配置渲染 ────────────────────────────────────────────
    def _render_models(self, models: List[Dict[str, Any]]) -> List[str]:
        lines: List[str] = ["        models:"]
        for model in models:
            model_id = str(model.get("id") or "")
            if not model_id:
                continue
            lines.append(f"          - id: {_yaml_str(model_id)}")
            name = model.get("name")
            if isinstance(name, str) and name and name != model_id:
                lines.append(f"            name: {_yaml_str(name)}")
            context = model.get("context_length")
            if isinstance(context, int) and context > 0:
                lines.append(f"            contextWindow: {context}")
            max_tokens = model.get("max_tokens")
            if isinstance(max_tokens, int) and max_tokens > 0:
                lines.append(f"            maxTokens: {max_tokens}")
            lines.append("            input:")
            lines.append("              - text")
            lines.append("            compat:")
            for key, value in MODEL_COMPAT.items():
                rendered = "true" if value is True else ("false" if value is False else str(value))
                lines.append(f"              {key}: {rendered}")
        return lines

    def _render_provider(self, key: str, base_url: str, token_env: str,
                         models: List[Dict[str, Any]]) -> List[str]:
        lines = [
            f"      {key}:",
            f"        displayName: {_yaml_str(DISPLAY_NAMES.get(key, key))}",
            f"        baseURL: {_yaml_str(base_url)}",
            "        api: openai-completions",
            f"        apiKeyEnv: {token_env}",
        ]
        lines.extend(self._render_models(models))
        return lines

    def _render_block(self, providers: List[List[str]], disable_official: bool,
                      include_host: bool = False) -> str:
        lines = [BEGIN]
        if include_host:
            # bundle 自己的 Host 半：提供 /workbuddy/status 给 Web UI（积分/倍率卡片）
            lines.extend([
                "# 本 bundle 的 Host 半（给 Web UI 提供同源状态接口）",
                "- insert:",
                f"    - id: {BUNDLE_PACKAGE}",
                f"      name: {BUNDLE_PACKAGE}",
            ])
        if disable_official:
            lines.extend([
                "# 官方插件与本地桥接会暴露同一批模型，关掉前者避免重复分组",
                "- id: llm-workbuddy",
                "  disabled: true",
            ])
        lines.extend(["- id: llm-pi-ai", "  config:", "    providers:"])
        for provider in providers:
            lines.extend(provider)
        lines.append(END)
        return "\n".join(lines) + "\n"

    @staticmethod
    def _strip_block(text: str) -> str:
        pattern = re.compile(
            r"\n*" + re.escape(BEGIN) + r".*?" + re.escape(END) + r"\n?",
            re.S,
        )
        return pattern.sub("\n", text)

    def _upsert_block(self, text: str, block: str) -> str:
        """替换受管块；没有就追加到文件末尾。保留文件其余内容与注释。

        注意：DSH 模板生成的 `cordis.patch.yml` 内容是空 flow 序列 `[]`。
        直接在其后追加 `- id:` 会得到非法 YAML（flow 序列已经闭合），
        所以先把顶格 `[]` 占位符丢掉。
        """
        body = self._strip_block(text).rstrip()
        body = "\n".join(
            line for line in body.splitlines()
            if not (line.strip() == "[]" and not line[:1].isspace())
        ).rstrip()
        if body == "":
            return block
        return body + "\n\n" + block

    # ── 令牌 ────────────────────────────────────────────────
    def _write_env(self, tokens: Dict[str, str]) -> List[str]:
        """把桥接令牌写进 ~/.dsh/.env（DSH 启动时加载进进程环境）。"""
        path = self.dsh_home / ".env"
        text = self._read(path)
        lines = text.splitlines() if text else []
        changed: List[str] = []
        for key, value in tokens.items():
            pattern = re.compile(rf"^\s*(?:export\s+)?{re.escape(key)}\s*=")
            replacement = f"{key}={value}"
            for index, line in enumerate(lines):
                if pattern.match(line):
                    if line.strip() != replacement:
                        lines[index] = replacement
                        changed.append(key)
                    break
            else:
                lines.append(replacement)
                changed.append(key)
        if changed:
            path.parent.mkdir(parents=True, exist_ok=True)
            self.write_text(path, "\n".join(lines).rstrip() + "\n")
        return changed

    # ── 安装 ────────────────────────────────────────────────
    def _collect(self, manager) -> tuple[List[List[str]], Dict[str, str], List[str]]:
        """构建 provider 段、待写令牌、以及告警行。"""
        providers: List[List[str]] = []
        tokens: Dict[str, str] = {}
        warnings: List[str] = []
        for inst in manager.instances():
            try:
                endpoint = self.endpoint(manager, inst.key)
            except Exception as exc:  # noqa: BLE001
                warnings.append(f"{inst.key}: 桥接不可用（{exc}），本 profile 不写入该 provider")
                continue
            if not endpoint.get("token"):
                warnings.append(f"{inst.key}: 读不到桥接令牌，跳过")
                continue
            models = endpoint.get("model_rows") or []
            if not models:
                warnings.append(f"{inst.key}: 桥接没有可用模型，跳过")
                continue
            providers.append(self._render_provider(
                inst.key, endpoint["base_url"], inst.token_env, models,
            ))
            tokens[inst.token_env] = endpoint["token"]
        return providers, tokens, warnings

    def bundle_dir(self) -> Path:
        """仓库里的 DSH bundle 包目录（`dsh/workbuddy-connect/`）。"""
        return self.repo_root() / BUNDLE_SUBDIR

    def bundle_installed(self) -> bool:
        """bundle 是否已被 DSH 装进某个 profile。"""
        return any(
            (profile / "node_modules" / BUNDLE_PACKAGE).exists()
            for profile in self.profiles()
        )

    def _bundle_manifest(self) -> Dict[str, Any]:
        return {
            "name": BUNDLE_PACKAGE,
            "version": "2.1.0",
            "private": True,
            "type": "module",
            "description": (
                "WorkBuddy 桌面 App 的模型接入 DeepSeek Harness：把本机 workbuddy-connect 桥接"
                "注册成 OpenAI 兼容 provider，并在输入框下方显示剩余积分与模型倍率。"
            ),
            "exports": {
                ".": "./index.js",
                "./client": "./client.js",
                "./locale/*.json": "./locale/*.json",
                "./icon": "./icon.svg",
            },
            "files": [
                "index.js", "client.js", PATCH_FILENAME, "locale/*.json", "icon.svg",
            ],
            "dsh": {
                "bundle": {"patch": f"./{PATCH_FILENAME}"},
                "client": {
                    "platform": "web",
                    "immediately": True,
                    # 声明 composer dock 插槽的宿主包
                    "inject": ["@deepseek-ai/dsh-client-ui-conversation"],
                },
            },
        }

    def write_bundle(self, manager) -> List[str]:
        """生成/刷新 bundle 包（package.json + 声明式 cordis.patch.yml）。"""
        providers, _tokens, warnings = self._collect(manager)
        if not providers:
            return ["没有可写入的 provider：" + ("; ".join(warnings) or "桥接未启动")]
        target = self.bundle_dir()
        target.mkdir(parents=True, exist_ok=True)
        (target / "package.json").write_text(
            json.dumps(self._bundle_manifest(), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        disable_official = any(
            (profile / "node_modules" / PLUGIN_PACKAGE).is_dir() for profile in self.profiles()
        )
        (target / PATCH_FILENAME).write_text(
            self._render_block(providers, disable_official, include_host=True), encoding="utf-8",
        )
        lines = [f"已生成 bundle：{target}"]
        if warnings:
            lines.extend(f"提示: {w}" for w in warnings)
        return lines

    def install(self, manager, *, profiles: str = "", dry_run: bool = False) -> List[str]:
        # 一旦 bundle 已安装，就以 bundle 为准：只刷新它的 patch，不再往 profile 写第二份
        if self.bundle_installed() and not profiles:
            if dry_run:
                return [f"将刷新 bundle patch：{self.bundle_dir() / PATCH_FILENAME}"]
            lines = self.write_bundle(manager)
            lines.append("DSH 需要重新加载该 bundle（重启）后才会用上新模型列表")
            return lines

        targets = self._targets(profiles)
        if not targets:
            return [f"没有找到 DSH profile（{self.dsh_home / 'profiles'}）"]

        providers, tokens, warnings = self._collect(manager)
        lines: List[str] = []
        if not providers:
            return ["没有可写入的 provider：" + ("; ".join(warnings) or "桥接未启动")]
        if warnings:
            lines.extend(f"提示: {w}" for w in warnings)

        if dry_run:
            lines.append(f"将写入 {len(targets)} 个 profile：{', '.join(p.name for p in targets)}")
            lines.append(f"  令牌变量：{', '.join(tokens)}")
            return lines

        changed = self._write_env(tokens)
        if changed:
            lines.append(f"已更新 {self.dsh_home / '.env'}：{', '.join(changed)}")

        for profile in targets:
            patch = profile / PATCH_FILENAME
            text = self._read(patch)
            block = self._render_block(providers, disable_official=(
                (profile / "node_modules" / PLUGIN_PACKAGE).is_dir()
            ))
            updated = self._upsert_block(text, block)
            if updated == text:
                lines.append(f"[{profile.name}] 配置已是最新")
                continue
            self.write_text(patch, updated)
            lines.append(f"[{profile.name}] 已写入 {patch}")
            legacy = self._legacy_patched(profile / "node_modules" / PLUGIN_PACKAGE)
            if legacy:
                lines.append(
                    f"[{profile.name}] 注意：官方插件仍带旧补丁（{', '.join(legacy)}）。"
                    "运行 `wbconnect dsh restore` 恢复原版；不改也不影响新的 provider 接入。"
                )

        lines.append("重启 DeepSeek Harness 后生效：新 provider 会以 WorkBuddy / WorkBuddy AI 分组出现在模型选择器里")
        return lines

    def uninstall(self, manager) -> List[str]:
        lines: List[str] = []
        for profile in self.profiles():
            patch = profile / PATCH_FILENAME
            text = self._read(patch)
            if BEGIN not in text:
                continue
            stripped = self._strip_block(text).rstrip()
            # 只剩注释时也必须补一个 `[]`：YAML 里"只有注释"是 null 文档，
            # Loader 会报 "must be a top-level YAML array"，profile 直接起不来。
            has_entries = any(
                line.strip() and not line.lstrip().startswith("#")
                for line in stripped.splitlines()
            )
            if has_entries:
                self.write_text(patch, stripped + "\n")
            else:
                self.write_text(patch, (stripped + "\n" if stripped else "") + "[]\n")
            lines.append(f"[{profile.name}] 已移除受管配置")
        if not lines:
            lines.append("没有找到受管配置")
        lines.append("令牌仍保留在 ~/.dsh/.env；如需彻底清理请手动删除 WORKBUDDY_(AI_)BRIDGE_TOKEN")
        return lines

    # ── 旧补丁恢复 ──────────────────────────────────────────
    def restore_legacy(self) -> List[str]:
        """把被就地打补丁的官方插件文件恢复成 vendor 里的原版（断掉 pnpm 硬链接）。"""
        vendor = self.repo_root() / "vendor" / PLUGIN_PACKAGE
        pristine_index = vendor / "lib" / "index.js"
        pristine_kernels = sorted((vendor / "lib").glob("host-heartbeat-*.js"))
        if not pristine_index.is_file():
            return [f"缺少原版文件：{pristine_index}"]
        vendor_version = self._version(vendor)
        lines: List[str] = []
        for plugin in self.plugin_dirs():
            installed_version = self._version(plugin)
            patched = self._legacy_patched(plugin)
            if not patched:
                lines.append(f"[{plugin.parent.parent.name}] 无需恢复")
                continue
            if installed_version != vendor_version:
                lines.append(
                    f"[{plugin.parent.parent.name}] 跳过：安装版本 {installed_version or '?'} 与原版 "
                    f"{vendor_version} 不一致，请直接重装该依赖"
                )
                continue
            lib = plugin / "lib"
            # 先删后拷：文件与 pnpm store 是硬链接，原地覆盖会写穿到全局 store
            for name in patched:
                target = plugin / name
                if target.exists():
                    target.unlink()
            shutil.copy2(pristine_index, lib / "index.js")
            for old in sorted(lib.glob("host-heartbeat-*.js")):
                old.unlink()
            for kernel in pristine_kernels:
                shutil.copy2(kernel, lib / kernel.name)
            remaining = self._legacy_patched(plugin)
            state = "已恢复" if not remaining else f"仍有残留：{', '.join(remaining)}"
            lines.append(f"[{plugin.parent.parent.name}] {state}")
        if lines and any("已恢复" in line for line in lines):
            lines.append(
                "注意：pnpm 全局 store 里同一内容的条目可能仍是被补丁改过的副本（硬链接写入所致）。"
                "DSH 已不再读取它；如需彻底修复，在有 pnpm 的环境里执行 `pnpm store prune` 后重装依赖。"
            )
        return lines
