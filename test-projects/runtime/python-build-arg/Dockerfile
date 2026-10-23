ARG PYTHON_VERSION=3.13.1

FROM python:${PYTHON_VERSION}-slim-bookworm AS app
WORKDIR /srv
COPY . .
CMD ["python", "-m", "app"]
