# Local web GUI for moving patterns between Syntakt .stprj backups.
#
#   docker build -t synpat .
#   docker run --rm -p 127.0.0.1:8765:8765 \
#     -v "/path/to/Elektron Syntakt/PROJECTS:/data/projects:ro" \
#     -v "/path/to/Elektron Syntakt/OLD BACKUP:/data/old-backup:ro" \
#     -v "/path/to/Elektron Syntakt/OUTPUT:/data/output" \
#     synpat
#   then open http://localhost:8765/ in Chrome.
#
# WebMIDI / SysEx device access happens in the HOST browser (Chrome on the Mac), not in the container,
# so the container needs no USB or MIDI access. Publish only on 127.0.0.1 (the GUI has no authentication).
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN useradd --create-home --uid 1000 app \
 && mkdir -p /data/projects /data/old-backup /data/output \
 && chown app:app /data/output
WORKDIR /app
COPY stprj/ stprj/
COPY web/__init__.py web/server.py web/plan.py web/
COPY web/static/ web/static/
USER app
EXPOSE 8765
ENTRYPOINT ["python", "-m", "web.server", "--host", "0.0.0.0", "--port", "8765", \
            "--projects", "/data/projects", "--projects", "/data/old-backup", "--output", "/data/output"]
