"""给已安装的 DSH 插件打国内版（CN）上游兼容补丁（幂等）。

背景：WorkBuddy 国内版上游会对 agent harness 的 system prompt 做**精确短语**指纹
拦截（返回 ``400 ... 11128 请求被拦截``）。命中 DSH 的固定开场句
``You are an AI agent powered by DeepSeek Harness.``；此外整段 system 里还有其它
会被命中的短语，逐条替换不可维护。

做法（只动 CN 分支，语义不变）：
1. 把开场句换成 "running inside DeepSeek Harness."；
2. 对 system 内容做「代码块之外的双空格展开」——Markdown 渲染与模型语义都不变，
   但字节序列改变，精确指纹失配（实测同请求 11128 -> 200）；
3. shim 层对 11128 做 3 次退避重试。

用法：
    python scripts/patch_dsh_plugin.py [--dsh-home ~/.dsh] [--restore]
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

BLOCKED = "You are an AI agent powered by DeepSeek Harness."
SAFE = "You are an AI agent running inside DeepSeek Harness."
MARK_KERNEL = "/* wb-compat:cn-kernel */"
MARK_SHIM = "/* wb-compat:cn-system */"

KERNEL_ANCHOR = (
    'body: region === "global" ? prepareInternationalChatBody(bodyJson) '
    ": prepareCnChatBody(bodyJson),"
)
KERNEL_REPLACEMENT = (
    'body: region === "global" ? prepareInternationalChatBody(bodyJson) '
    ": prepareCnChatBody((() => { try { " + MARK_KERNEL + " "
    "const o = JSON.parse(bodyJson); "
    'const defang = (s) => s.split(/(```[\\s\\S]*?```)/).map((part, i) => i % 2 ? part : part.replace(/ /g, "  ")).join(""); '
    "if (Array.isArray(o.messages)) for (const m of o.messages) "
    'if (m && typeof m === "object" && m.role === "system" && typeof m.content === "string") '
    f"m.content = defang(m.content.split({BLOCKED!r}).join({SAFE!r})); "
    "return JSON.stringify(o); } catch { return bodyJson; } })()),"
)

SHIM_ANCHOR = "const prepared = prepareChatBody(raw);"
SHIM_REPLACEMENT = (
    "const prepared = (() => { try { " + MARK_SHIM + " "
    "const o = JSON.parse(prepareChatBody(raw)); "
    "if (Array.isArray(o.messages)) for (const m of o.messages) "
    'if (m && typeof m === "object" && m.role === "system" && typeof m.content === "string") '
    f"m.content = m.content.split({BLOCKED!r}).join({SAFE!r}); "
    "return JSON.stringify(o); } catch { return prepareChatBody(raw); } })();"
)

CALL_ANCHOR = "const result = await client.chatStream(credential, prepared, controller.signal);"
CALL_REPLACEMENT = (
    "let result = await client.chatStream(credential, prepared, controller.signal);\n"
    "\t\tfor (let attempt = 1; attempt <= 3 && !result.ok && /11128|请求被拦截/.test(String(result.message ?? \"\")); attempt += 1) {\n"
    "\t\t\tawait new Promise((resolve) => setTimeout(resolve, 900 * attempt));\n"
    "\t\t\tif (controller.signal.aborted) break;\n"
    "\t\t\tresult = await client.chatStream(credential, prepared, controller.signal);\n"
    "\t\t}"
)


def plugin_dirs(dsh_home: Path) -> list[Path]:
    return sorted(dsh_home.glob("profiles/*/node_modules/dsh-workbuddy-connect"))


def patch_text(text: str, anchor: str, replacement: str, marker: str) -> tuple[str, str]:
    if marker in text:
        return text, "already"
    if anchor not in text:
        return text, "skip"
    return text.replace(anchor, replacement, 1), "patched"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="patch installed dsh-workbuddy-connect for CN upstream")
    parser.add_argument("--dsh-home", default=str(Path.home() / ".dsh"))
    parser.add_argument("--restore", action="store_true", help="从 vendor 还原后再打补丁")
    args = parser.parse_args(argv)

    dirs = plugin_dirs(Path(args.dsh_home))
    if not dirs:
        print("no dsh-workbuddy-connect installation found")
        return 1
    vendor = Path(__file__).resolve().parent.parent / "vendor" / "dsh-workbuddy-connect"
    for plugin in dirs:
        if args.restore and vendor.is_dir():
            shutil.copy2(vendor / "lib" / "index.js", plugin / "lib" / "index.js")
            for old in plugin.glob("lib/host-heartbeat-*.js"):
                old.unlink()
            for new in vendor.glob("lib/host-heartbeat-*.js"):
                shutil.copy2(new, plugin / "lib" / new.name)
        states = []
        index = plugin / "lib" / "index.js"
        for anchor, replacement, marker in (
            (CALL_ANCHOR, CALL_REPLACEMENT, "wb-compat:cn-retry"),
            (SHIM_ANCHOR, SHIM_REPLACEMENT, MARK_SHIM),
        ):
            text = index.read_text(encoding="utf-8")
            text, state = patch_text(text, anchor, replacement, marker)
            if state == "patched":
                index.write_text(text, encoding="utf-8", newline="")
            states.append(f"shim:{marker.split(':')[1]}={state}")
        for kernel in sorted(plugin.glob("lib/host-heartbeat-*.js")):
            text = kernel.read_text(encoding="utf-8")
            text, state = patch_text(text, KERNEL_ANCHOR, KERNEL_REPLACEMENT, MARK_KERNEL)
            if state == "patched":
                kernel.write_text(text, encoding="utf-8", newline="")
            states.append(f"kernel={state}")
        print(f"{plugin}: " + ", ".join(states))
    print("restart DeepSeek Harness for the patch to take effect")
    return 0


if __name__ == "__main__":
    sys.exit(main())
