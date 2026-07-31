from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class PersonalCommand:
    device: str
    action: str
    room: str | None = None
    value: Any = None


ROOM_ALIASES = {
    "客厅": "客厅",
    "大厅": "客厅",
    "主卧": "主卧",
    "主卧室": "主卧",
    "次卧": "次卧",
    "次卧室": "次卧",
}

CHINESE_TEMPERATURES = {
    "十六": 16,
    "十七": 17,
    "十八": 18,
    "十九": 19,
    "二十": 20,
    "二十一": 21,
    "二十二": 22,
    "二十三": 23,
    "二十四": 24,
    "二十五": 25,
    "二十六": 26,
    "二十七": 27,
    "二十八": 28,
    "二十九": 29,
    "三十": 30,
}


def normalize_utterance(value: Any) -> str:
    text = str(value or "").strip().lower()
    return re.sub(r"[\s，。！？、,.!?：:；;]+", "", text)


def _room(text: str) -> str | None:
    for alias, room in ROOM_ALIASES.items():
        if alias in text:
            return room
    return None


def _temperature(text: str) -> float | None:
    match = re.search(r"(1[6-9]|2\d|30)(?:\.(5))?(?:度|摄氏度)?", text)
    if match:
        value = float(match.group(1))
        if match.group(2):
            value += 0.5
        return value
    for label, value in sorted(
        CHINESE_TEMPERATURES.items(),
        key=lambda item: len(item[0]),
        reverse=True,
    ):
        if label in text:
            return value + (0.5 if f"{label}度半" in text else 0)
    return None


def parse_personal_command(utterance: Any) -> PersonalCommand:
    text = normalize_utterance(utterance)
    room = _room(text)
    query = any(word in text for word in ("多少", "状态", "怎么样", "开着吗", "运行吗"))
    turn_off = any(word in text for word in ("关闭", "关掉", "关机", "停止"))

    if any(word in text for word in ("扫地", "追觅", "机器人", "回充", "充电座")):
        if any(word in text for word in ("回充", "充电", "回去")):
            return PersonalCommand("dreame", "charge")
        if "暂停" in text:
            return PersonalCommand("dreame", "pause")
        if turn_off:
            return PersonalCommand("dreame", "stop")
        if query:
            return PersonalCommand("dreame", "status")
        return PersonalCommand("dreame", "start")

    if "电视" in text:
        if query:
            return PersonalCommand("tv", "status")
        if "取消静音" in text or "恢复声音" in text:
            return PersonalCommand("tv", "mute", value=False)
        if "静音" in text:
            return PersonalCommand("tv", "mute", value=True)
        return PersonalCommand("tv", "power", value=not turn_off)

    if "插座" in text:
        if query:
            return PersonalCommand("plug", "status")
        return PersonalCommand("plug", "power", value=not turn_off)

    if any(word in text for word in ("浴霸", "暖风", "换气", "吹风", "干燥")):
        if query:
            return PersonalCommand("aupu", "status")
        if turn_off:
            return PersonalCommand("aupu", "mode", value=0)
        modes = {
            "弱暖风": 1,
            "强暖风": 2,
            "暖风": 2,
            "吹风": 3,
            "换气": 4,
            "干燥": 5,
            "杀菌": 6,
            "除臭": 6,
        }
        mode = next((value for label, value in modes.items() if label in text), 2)
        return PersonalCommand("aupu", "mode", value=mode)

    if any(word in text for word in ("灯", "照明")):
        if query:
            return PersonalCommand("light", "status")
        brightness = re.search(r"(\d{1,3})(?:%|百分之)", text)
        if brightness:
            return PersonalCommand(
                "light",
                "brightness",
                value=max(4, min(100, int(brightness.group(1)))),
            )
        return PersonalCommand("light", "power", value=not turn_off)

    if "空调" in text or room:
        room = room or "客厅"
        if query:
            return PersonalCommand("ac", "status", room=room)
        temperature = _temperature(text)
        if temperature is not None:
            return PersonalCommand("ac", "temperature", room=room, value=temperature)
        modes = {
            "自动": "auto",
            "制冷": "cool",
            "除湿": "dry",
            "送风": "fan",
            "制热": "heat",
        }
        mode = next((value for label, value in modes.items() if label in text), None)
        if mode:
            return PersonalCommand("ac", "mode", room=room, value=mode)
        if "强劲" in text or "强风" in text:
            return PersonalCommand("ac", "turbo", room=room, value=not turn_off)
        if "睡眠" in text:
            return PersonalCommand("ac", "sleep", room=room, value=not turn_off)
        return PersonalCommand("ac", "power", room=room, value=not turn_off)

    return PersonalCommand("unknown", "help")


def personal_response(reply: str, *, success: bool = True) -> dict[str, Any]:
    return {
        "returnCode": "0",
        "returnErrorSolution": "",
        "returnMessage": "",
        "returnValue": {
            "reply": reply,
            "resultType": "RESULT",
            "executeCode": "SUCCESS" if success else "EXECUTE_ERROR",
            "msgInfo": "",
        },
    }
