# trace-pong server: Python stdlib only, serves ../web and bridges to Tempo + Mimir.
FROM python:3.13-alpine
WORKDIR /app
COPY server/ server/
COPY web/ web/
ENV PYTHONUNBUFFERED=1 PORT=8077
EXPOSE 8077
CMD ["python", "server/tracepong.py"]
