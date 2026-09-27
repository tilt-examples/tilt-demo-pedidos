FROM docker.io/library/python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY *.py *.json ./
ENV PYTHONUNBUFFERED=1 PORTA=8080
EXPOSE 8080
CMD ["python", "servico.py"]
