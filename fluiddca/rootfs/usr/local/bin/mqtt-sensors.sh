#!/usr/bin/with-contenv bashio
# mqtt-sensors.sh - MQTT Discovery for FluidDCA sensors

MQTT_HOST=$(bashio::services mqtt "host")
MQTT_PORT=$(bashio::services mqtt "port")
MQTT_USER=$(bashio::services mqtt "username")
MQTT_PASS=$(bashio::services mqtt "password")

DISCOVERY_PREFIX="homeassistant"
DEVICE_ID="fluiddca"

# Publish MQTT message
mqtt_pub() {
    local topic="$1"
    local payload="$2"
    local retain="${3:-true}"

    mosquitto_pub -h "${MQTT_HOST}" -p "${MQTT_PORT}" \
        -u "${MQTT_USER}" -P "${MQTT_PASS}" \
        -t "${topic}" -m "${payload}" ${retain:+-r}
}

# Initialize sensors via MQTT Discovery
init_sensors() {
    bashio::log.info "Publishing MQTT discovery configs..."

    # Last execution sensor
    mqtt_pub "${DISCOVERY_PREFIX}/sensor/${DEVICE_ID}_last_execution/config" "$(jq -n \
        --arg name "FluidDCA Last Execution" \
        --arg uid "${DEVICE_ID}_last_execution" \
        --arg state_topic "fluiddca/status/last_execution" \
        '{name: $name, unique_id: $uid, state_topic: $state_topic, device_class: "timestamp", device: {identifiers: ["fluiddca"], name: "FluidDCA", manufacturer: "Custom"}}')"

    # Status sensor
    mqtt_pub "${DISCOVERY_PREFIX}/sensor/${DEVICE_ID}_status/config" "$(jq -n \
        --arg name "FluidDCA Status" \
        --arg uid "${DEVICE_ID}_status" \
        --arg state_topic "fluiddca/status/state" \
        '{name: $name, unique_id: $uid, state_topic: $state_topic, device: {identifiers: ["fluiddca"]}}')"

    # Can execute binary sensor
    mqtt_pub "${DISCOVERY_PREFIX}/binary_sensor/${DEVICE_ID}_can_execute/config" "$(jq -n \
        --arg name "FluidDCA Can Execute" \
        --arg uid "${DEVICE_ID}_can_execute" \
        --arg state_topic "fluiddca/status/can_execute" \
        '{name: $name, unique_id: $uid, state_topic: $state_topic, payload_on: "true", payload_off: "false", device: {identifiers: ["fluiddca"]}}')"

    bashio::log.info "MQTT discovery configs published"
}

# Update sensor states
# Status values: executed, low_balance, error
update_sensors() {
    local status="$1"

    # Always update status
    mqtt_pub "fluiddca/status/state" "${status}" true

    # Only update last_execution timestamp when a transaction was actually sent
    if [ "${status}" = "executed" ]; then
        mqtt_pub "fluiddca/status/last_execution" "$(date -Iseconds)" true
    fi

    # can_execute = true only when balance is sufficient (not low_balance)
    # "executed" means it was ready and ran
    # "low_balance" means balance below threshold
    # "error" means something went wrong (could be various reasons)
    if [ "${status}" = "executed" ]; then
        # Just executed, so it was ready
        mqtt_pub "fluiddca/status/can_execute" "true" true
    elif [ "${status}" = "low_balance" ]; then
        # Balance below threshold - cannot execute
        mqtt_pub "fluiddca/status/can_execute" "false" true
    else
        # Error state - unknown, keep previous value or set false
        mqtt_pub "fluiddca/status/can_execute" "false" true
    fi
}

case "${1}" in
    init)
        init_sensors
        ;;
    update)
        update_sensors "${2}"
        ;;
    *)
        bashio::log.error "Usage: mqtt-sensors.sh <init|update> [status]"
        exit 1
        ;;
esac
