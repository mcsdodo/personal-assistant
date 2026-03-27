FROM python:3.12-slim
WORKDIR /app

RUN pip install --no-cache-dir mcp[cli] uvicorn requests python-dotenv flask

# match_invoices.py is copied here by the build script (build.sh)
# or symlinked during local dev. Source: compose.stacks/media-gpu/paperless/local/checker/
COPY match_invoices.py server.py webapp.py entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 5000 8001
CMD ["./entrypoint.sh"]
