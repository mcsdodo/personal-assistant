FROM python:3.12-slim
WORKDIR /app

RUN pip install --no-cache-dir \
    mcp[cli] uvicorn \
    requests beautifulsoup4 msal

COPY server.py ./

EXPOSE 8002
CMD ["python", "server.py"]
