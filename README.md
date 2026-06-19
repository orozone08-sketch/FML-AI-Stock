# FAstockFlow

Server-rendered Flask implementation of the FAstockFlow stock, FIFO, payment, outstanding, and inter-company control system.

## Local Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
flask init-db
flask seed-data
flask run
```

Default seeded admin credentials are controlled by `.env`:

- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`

## Docker

```bash
cp .env.example .env
docker compose up --build
docker compose exec web flask init-db
docker compose exec web flask seed-data
```

Open `http://localhost:8000`.

## Notes

- MySQL is the production target.
- SQLite is supported for tests and quick local smoke checks.
- Stock is never edited directly. Opening stock, purchase, sale, and transfer documents create FIFO layers and ledger entries.
