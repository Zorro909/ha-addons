#!/usr/bin/with-contenv bashio

# FluidDCA Notification Helper
# Usage: notify.sh <success|error> <output_file> [exit_code]

EVENT_TYPE="${1}"
OUTPUT_FILE="${2}"
EXIT_CODE="${3:-0}"

# Read notification settings from environment (set by run.sh)
NOTIFY_SERVICE="${NOTIFY_SERVICE:-}"

# Parse execution output for details
parse_output() {
    local file="$1"
    TX_HASH=""
    AMOUNTS=""
    if [ -f "$file" ]; then
        # Extract tx hash if present (look for common patterns)
        TX_HASH=$(grep -oE '0x[a-fA-F0-9]{64}' "$file" | head -1 || true)
        # Extract amounts (look for EURe, USDC, ETH values)
        AMOUNTS=$(grep -iE '(eure|usdc|eth|wei).*[0-9]' "$file" | head -3 | tr '\n' ' ' || true)
    fi
}

# Send persistent notification using jq for safe JSON escaping
send_persistent_notification() {
    local title="$1"
    local message="$2"
    local notification_id="$3"

    bashio::log.debug "Sending persistent notification: ${title}"

    # Use jq to safely construct JSON (handles quotes, newlines, special chars)
    local payload
    payload=$(jq -n \
        --arg title "$title" \
        --arg message "$message" \
        --arg id "$notification_id" \
        '{title: $title, message: $message, notification_id: $id}')

    bashio::core.api POST /api/services/persistent_notification/create "$payload" \
        > /dev/null 2>&1 || bashio::log.warning "Failed to send persistent notification"
}

# Send to custom notify service (if configured)
send_notify_service() {
    local title="$1"
    local message="$2"

    if [ -z "${NOTIFY_SERVICE}" ]; then
        return 0
    fi

    bashio::log.debug "Sending to notify service: ${NOTIFY_SERVICE}"

    # Extract service domain and name (e.g., "notify.matrix_notify" -> "notify" and "matrix_notify")
    local domain="${NOTIFY_SERVICE%%.*}"
    local service="${NOTIFY_SERVICE#*.}"

    # Use jq for safe JSON construction
    local payload
    payload=$(jq -n \
        --arg title "$title" \
        --arg message "$message" \
        '{title: $title, message: $message}')

    bashio::core.api POST "/api/services/${domain}/${service}" "$payload" \
        > /dev/null 2>&1 || bashio::log.warning "Failed to send to ${NOTIFY_SERVICE}"
}

# Main logic
case "${EVENT_TYPE}" in
    success)
        parse_output "${OUTPUT_FILE}"

        TITLE="FluidDCA: Transaction Executed"
        MESSAGE="DCA execution completed successfully."

        if [ -n "${TX_HASH}" ]; then
            MESSAGE="${MESSAGE}

Tx: ${TX_HASH}"
        fi
        if [ -n "${AMOUNTS}" ]; then
            MESSAGE="${MESSAGE}

${AMOUNTS}"
        fi

        MESSAGE="${MESSAGE}

Time: $(date -Iseconds)"

        send_persistent_notification "${TITLE}" "${MESSAGE}" "fluiddca_success"
        send_notify_service "${TITLE}" "${MESSAGE}"
        ;;

    error)
        parse_output "${OUTPUT_FILE}"

        TITLE="FluidDCA: Execution Failed"
        MESSAGE="DCA execution failed with exit code ${EXIT_CODE}."

        # Include last few lines of output for debugging
        if [ -f "${OUTPUT_FILE}" ]; then
            ERROR_DETAILS=$(tail -10 "${OUTPUT_FILE}" | head -5 || true)
            if [ -n "${ERROR_DETAILS}" ]; then
                MESSAGE="${MESSAGE}

Details:
${ERROR_DETAILS}"
            fi
        fi

        MESSAGE="${MESSAGE}

Time: $(date -Iseconds)"

        send_persistent_notification "${TITLE}" "${MESSAGE}" "fluiddca_error"
        send_notify_service "${TITLE}" "${MESSAGE}"
        ;;

    *)
        bashio::log.error "Unknown event type: ${EVENT_TYPE}"
        exit 1
        ;;
esac

bashio::log.info "Notification sent for event: ${EVENT_TYPE}"
