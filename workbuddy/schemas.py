"""WorkBuddy 插件的工具 schema（LLM 看到的描述与参数）。"""

STATUS = {
    "name": "workbuddy_status",
    "description": (
        "查看 WorkBuddy 桥接状态：两个实例（国内版 workbuddy / 国际版 workbuddy-ai）是否在运行、"
        "登录态、模型数量、积分，以及当前 profile 是否已注册对应 provider。不会启动或修改任何东西。"
    ),
    "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
}

MODELS = {
    "name": "workbuddy_models",
    "description": (
        "列出 WorkBuddy 桥接暴露的模型（id、名称、上下文长度、倍率）。桥接没在跑时会先自动启动。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "instance": {
                "type": "string",
                "enum": ["all", "workbuddy", "workbuddy-ai"],
                "description": "要查询的实例，默认 all",
            }
        },
        "additionalProperties": False,
    },
}

SYNC = {
    "name": "workbuddy_sync",
    "description": (
        "把 WorkBuddy 桥接的模型写入 Hermes 配置（providers.<名字> + .env 令牌），必要时启动桥接。"
        "默认只同步当前 profile；profiles 可传 all 或逗号分隔的 profile 名（例如机器人 profile）。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "profiles": {
                "type": "string",
                "description": "留空=仅当前 profile；all=所有 profile；或逗号分隔的名字（如 hacker,white-hat）",
            }
        },
        "additionalProperties": False,
    },
}
