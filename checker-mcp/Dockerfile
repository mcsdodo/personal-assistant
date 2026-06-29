FROM python:3.12-slim
WORKDIR /app

RUN pip install --no-cache-dir mcp[cli] uvicorn requests python-dotenv flask

COPY match_invoices.py server.py webapp.py result_format.py entrypoint.sh ./
COPY engine/ ./engine/
RUN chmod +x entrypoint.sh

EXPOSE 5000 8001
CMD ["./entrypoint.sh"]
