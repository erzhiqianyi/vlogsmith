#!/bin/bash
# One command to start both the Flask API and the React dev server together.
# Ctrl+C stops both.
set -e
cd "$(dirname "$0")"
trap 'kill 0' EXIT
.venv/bin/python app.py &
npm --prefix frontend run dev &
wait
