import asyncio
import hashlib
import hmac
import json
import os
import uuid
from datetime import datetime
from urllib.parse import parse_qsl

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

load_dotenv()

BOT_TOKEN = os.getenv("TELEGRAM_TOKEN")
DATA_FILE = "shopping_data.json"

app = FastAPI()

# CORS — на случай, если фронт открыт с другого домена
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # для продакшена укажите свой домен
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------- Storage с lock ----------

_lock = asyncio.Lock()

def load_data() -> dict:
    if not os.path.exists(DATA_FILE):
        return {"shopping": [], "completed": [], "version": 5}
    with open(DATA_FILE, "r", encoding="utf-8") as f:
        return json.load(f)

def save_data(data: dict) -> None:
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=4)
    os.replace(tmp, DATA_FILE)

# ---------- Проверка initData ----------

def validate_init_data(init_data: str) -> dict:
    if not init_data:
        raise HTTPException(401, "initData отсутствует")
    try:
        parsed = dict(parse_qsl(init_data))
        hash_ = parsed.pop("hash", None)
        if not hash_:
            raise HTTPException(401, "hash отсутствует")

        data_check_string = "\n".join(
            f"{k}={v}" for k, v in sorted(parsed.items())
        )
        secret_key = hmac.new(
            b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256
        ).digest()
        computed = hmac.new(
            secret_key, data_check_string.encode(), hashlib.sha256
        ).hexdigest()

        if not hmac.compare_digest(computed, hash_):
            raise HTTPException(401, "Неверная подпись")

        return parsed
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(401, f"Ошибка проверки: {e}")

# ---------- API ----------

@app.get("/api/shopping")
async def get_shopping(x_telegram_init_data: str = Header("")):
    validate_init_data(x_telegram_init_data)
    async with _lock:
        data = load_data()
        return data.get("shopping", [])


@app.post("/api/shopping")
async def update_shopping(
    request: Request,
    x_telegram_init_data: str = Header(""),
):
    user = validate_init_data(x_telegram_init_data)
    payload = await request.json()
    action = payload.get("action")

    async with _lock:
        data = load_data()
        shopping = data.setdefault("shopping", [])

        # ---------- ADD ----------
        if action == "add":
            name = str(payload.get("name", "")).strip()[:100]
            if not name:
                raise HTTPException(400, "Пустое имя")
            product = {
                "id": uuid.uuid4().hex[:10],
                "name": name,
                "bought": False,
                "added_at": datetime.now().strftime("%d.%m.%Y %H:%M:%S"),
                "added_by": user.get("first_name", ""),
            }
            shopping.append(product)
            save_data(data)
            return {"product": product}

        # ---------- TOGGLE ----------
        if action == "toggle":
            pid = payload.get("id")
            for p in shopping:
                if p["id"] == pid:
                    p["bought"] = not p.get("bought", False)
                    p["bought_at"] = (
                        datetime.now().strftime("%d.%m.%Y %H:%M:%S")
                        if p["bought"] else None
                    )
                    p["bought_by"] = user.get("first_name", "") if p["bought"] else None
                    save_data(data)
                    return {"product": p}
            raise HTTPException(404, "Товар не найден")

        # ---------- DELETE ----------
        if action == "delete":
            pid = payload.get("id")
            before = len(shopping)
            data["shopping"] = [p for p in shopping if p["id"] != pid]
            if len(data["shopping"]) == before:
                raise HTTPException(404, "Товар не найден")
            save_data(data)
            return {"ok": True}

        # ---------- CLEAR BOUGHT ----------
        if action == "clear_bought":
            bought = [p for p in shopping if p.get("bought")]
            data["shopping"] = [p for p in shopping if not p.get("bought")]
            completed = data.setdefault("completed", [])
            for p in bought:
                completed.append({
                    "product": p["name"],
                    "bought_by": p.get("bought_by", ""),
                    "date": p.get("bought_at") or datetime.now().strftime("%d.%m.%Y %H:%M:%S"),
                })
            save_data(data)
            return {"moved": len(bought)}

        raise HTTPException(400, f"Неизвестное действие: {action}")


# ---------- Раздача статики ----------
# ВАЖНО: монтируем ПОСЛЕ API-роутов
app.mount("/", StaticFiles(directory=".", html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)