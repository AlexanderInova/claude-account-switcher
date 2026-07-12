FROM python:3.12-slim

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

ENV CAS_DB_PATH=/data/switcher.db
# Anonymous volume so data survives container recreation even without an
# explicit -v flag; docker-compose.yml names it properly.
VOLUME /data
EXPOSE 8787

CMD ["claude-switcher-sync"]
