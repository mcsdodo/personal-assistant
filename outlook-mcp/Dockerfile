FROM python:3.12-slim
WORKDIR /app

RUN pip install --no-cache-dir \
    "mcp[cli]<2.0.0" uvicorn \
    requests msal

COPY server.py ./

EXPOSE 8002
CMD ["python", "server.py"]
