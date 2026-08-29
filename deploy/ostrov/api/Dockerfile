FROM python:3.12-alpine
WORKDIR /app
COPY server.py .
ENV SCORES_FILE=/data/scores.json PORT=8000
EXPOSE 8000
CMD ["python", "-u", "server.py"]
