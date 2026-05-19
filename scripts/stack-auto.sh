#!/bin/bash
# scripts/stack-auto.sh
# Management script for 24/7 automated trading bot watchdog.

PROJECT_DIR="/home/nemesis/project/trading-workspace/coindcx/binance"
LOG_DIR="$PROJECT_DIR/logs"
LOG_FILE="$LOG_DIR/stack-auto.log"
SCREEN_NAME="trading-bot-stack"

mkdir -p "$LOG_DIR"
cd "$PROJECT_DIR" || exit 1

case "$1" in
  start|check)
    # Check if dependencies (Docker) are up
    # We use 'docker compose ps' to check status
    if ! docker compose ps | grep -q "Up"; then
      echo "$(date): [WATCHDOG] Docker containers down. Restarting dependencies..." >> "$LOG_FILE"
      docker compose up -d >> "$LOG_FILE" 2>&1
    fi
    
    # Check if the bot process (screen session) is running
    if ! screen -list | grep -q "$SCREEN_NAME"; then
      echo "$(date): [WATCHDOG] Bot stack not found in screen. Starting..." >> "$LOG_FILE"
      # Start in detached screen
      screen -dmS "$SCREEN_NAME" bash -c "npm run dashboard:ui"
      echo "$(date): [SUCCESS] Bot stack started." >> "$LOG_FILE"
    else
      # Optional: Add deeper health check here if needed (e.g. ping local API)
      if [[ "$1" == "start" ]]; then
         echo "$(date): [INFO] Start requested, but stack is already running." >> "$LOG_FILE"
      fi
    fi
    ;;
    
  stop)
    echo "$(date): [STOP] Manual shutdown initiated..." >> "$LOG_FILE"
    if screen -list | grep -q "$SCREEN_NAME"; then
      screen -S "$SCREEN_NAME" -X quit
      echo "$(date): [SUCCESS] Killed screen session '$SCREEN_NAME'." >> "$LOG_FILE"
    fi
    pkill -f "node.*src/index.ts" >> "$LOG_FILE" 2>&1
    pkill -f "vite" >> "$LOG_FILE" 2>&1
    docker compose down >> "$LOG_FILE" 2>&1
    echo "$(date): [SUCCESS] Automated shutdown complete." >> "$LOG_FILE"
    ;;
    
  status)
    if screen -list | grep -q "$SCREEN_NAME"; then
      echo "Status: RUNNING (Screen: $SCREEN_NAME)"
    else
      echo "Status: STOPPED"
    fi
    docker compose ps
    ;;
    
  *)
    echo "Usage: $0 {start|check|stop|status}"
    exit 1
    ;;
esac
