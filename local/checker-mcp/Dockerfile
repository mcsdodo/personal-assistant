FROM python:3.12-slim
WORKDIR /app

RUN pip install --no-cache-dir mcp[cli] uvicorn requests python-dotenv

# match_invoices.py is copied here by the build script (build.sh)
# or symlinked during local dev. Source: compose.stacks/media-gpu/paperless/local/checker/
COPY match_invoices.py server.py ./

EXPOSE 8001
CMD ["python", "server.py"]
