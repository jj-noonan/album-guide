# Read-only catalog API. The database is baked into the image rather than
# mounted on a volume: nothing writes to it at runtime, so there is no state to
# lose, no volume to pay for, and "update the data" is the same action as
# "deploy". A machine that dies is replaced from the image with no drift.
FROM python:3.13-slim

WORKDIR /app

# No dependencies. The server is standard library only, so there is no
# requirements.txt, no pip install layer, and nothing to patch on a schedule.
COPY api/server.py /app/api/server.py
COPY data/catalog-api.sqlite /app/data/catalog-api.sqlite

# Fly sets PORT; HOST must be 0.0.0.0 or the machine is unreachable from
# outside itself.
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080

CMD ["python", "/app/api/server.py"]
