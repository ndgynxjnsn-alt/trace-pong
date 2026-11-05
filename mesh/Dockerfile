FROM python:3.13-slim
RUN pip install --no-cache-dir \
      opentelemetry-sdk==1.38.0 \
      opentelemetry-exporter-otlp-proto-http==1.38.0
WORKDIR /app
COPY topology.py mesh.py ./
ENV PYTHONUNBUFFERED=1
CMD ["python", "mesh.py"]
