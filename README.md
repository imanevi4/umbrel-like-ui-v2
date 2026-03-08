# imanevi4-umbrel-like-ui v2

Что уже внутри:
- login + session auth
- HTTPS mode
- state model: `servers[] + services[]`
- accordion groups by server
- global search
- drag & drop servers
- drag & drop services inside one server
- credentials + links in service cards
- backward-compatible import from old flat JSON
- Docker autodiscovery import via `/var/run/docker.sock`

## 1. Клонирование

```bash
git clone https://github.com/imanevi4/imanevi4-umbrel-like-ui.git
cd imanevi4-umbrel-like-ui
```

## 2. Сгенерировать hash пароля

```bash
docker run --rm -v "$PWD":/app -w /app node:20-alpine sh -lc 'npm install >/dev/null 2>&1 && npm run hash-password -- "YOUR_STRONG_PASSWORD"'
```

## 3. Указать secret и hash

Открой `docker-compose.yml` и замени:
- `SESSION_SECRET`
- `ADMIN_BOOTSTRAP_PASSWORD_HASH`

Генерация секрета:

```bash
openssl rand -hex 32
```

## 4. Подготовить сертификаты

Путь:
- `./certs/fullchain.pem`
- `./certs/privkey.pem`

Если пока нужен test cert:

```bash
mkdir -p certs
openssl req -x509 -nodes -newkey rsa:4096 \
  -keyout certs/privkey.pem \
  -out certs/fullchain.pem \
  -days 365 \
  -subj "/CN=YOUR_DOMAIN_OR_IP"
```

## 5. Запуск

```bash
docker compose up -d --build
```

## 6. Проверка

```bash
docker compose ps
docker compose logs -f
curl -k https://localhost:8088/health
```

## 7. Доступ

```text
https://YOUR_HOST:8088
```

## 8. Перезапуск

```bash
docker compose restart
```

## 9. Обновление

```bash
git pull
docker compose up -d --build
```

## 10. Остановка

```bash
docker compose down
```

## 11. Формат данных

Главный файл:

```text
data/state.json
```

Пример:

```json
{
  "servers": [
    {
      "id": "srv-france",
      "name": "Франция",
      "ip": "45.95.173.144",
      "baseUrl": "https://welcome.aiww.ru",
      "description": "Основной хост",
      "expanded": true,
      "order": 1,
      "tags": ["prod", "eu"]
    }
  ],
  "services": [
    {
      "id": "svc-france-n8n",
      "serverId": "srv-france",
      "name": "n8n",
      "url": "https://n8n.aiww.ru",
      "description": "Workflow Automation",
      "category": "Automation",
      "iconUrl": "",
      "healthUrl": "https://n8n.aiww.ru",
      "checkMethod": "http",
      "pinned": true,
      "order": 1,
      "credentials": [],
      "links": [],
      "notes": ""
    }
  ],
  "meta": {
    "version": 2,
    "updatedAt": "2026-03-08T00:00:00.000Z"
  }
}
```

## 12. Важно

- credentials хранятся в `state.json` как обычные данные. Это **не vault**.
- autodiscovery использует Docker socket. Это удобно, но чувствительно по безопасности.
- перенос drag & drop между разными серверами пока не реализован.
