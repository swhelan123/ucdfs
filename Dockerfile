FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .
COPY static/ ./static/

# Profile photos. docker-compose mounts a host directory over this; the mkdir is
# so the app still starts (and uploads still work, if not persistently) when it
# is run without the mount, which is exactly what tests/run.sh does.
RUN mkdir -p /app/uploads/avatars

EXPOSE 3978

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3978"]