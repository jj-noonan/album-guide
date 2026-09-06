# Read-only catalog API. The database is baked into the image rather than
# mounted on a volume: nothing writes to it at runtime, so there is no state to
# lose, no volume to pay for, and "update the data" is the same action as
# "deploy". A machine that dies is replaced from the image with no drift.
FROM python:3.13-slim

WORKDIR /app

# No dependencies. The server is standard library only, so there is no
# requirements.txt, no pip install layer, and nothing to patch on a schedule.
# Everything the server opens at runtime, and nothing else. Phase 2 added the
# engine and its constants; a Dockerfile that still copied only the server and
# the database would build cleanly and die on the first import, which is a
# deploy that reports success and a machine that never answers.
COPY api/server.py /app/api/server.py
COPY api/engine.py /app/api/engine.py
COPY data/lexicon.json /app/data/lexicon.json
COPY data/engine-constants.json /app/data/engine-constants.json
COPY data/catalog-api.sqlite /app/data/catalog-api.sqlite

# Fly sets PORT; HOST must be 0.0.0.0 or the machine is unreachable from
# outside itself.
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080

CMD ["python", "/app/api/server.py"]
