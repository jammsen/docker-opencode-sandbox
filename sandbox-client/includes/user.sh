# App user/group setup — creates or realigns agent user to PUID/PGID and
# fixes file ownership when anything changed.

setup_app_user() {
    local current_gid current_uid needs_chown=false
    current_gid=$(getent group "$APP_GROUP" 2>/dev/null | cut -d: -f3)
    current_uid=$(id -u "$APP_USER" 2>/dev/null || echo "")

    if [[ -z "$current_gid" ]]; then
        e "> Group '$APP_GROUP' not found — creating with GID=${PGID}"
        groupadd "$APP_GROUP" --gid "${PGID}"
        needs_chown=true
    elif [[ "$current_gid" -ne "${PGID}" ]]; then
        e "> Group '$APP_GROUP' found with GID=${current_gid} — updating to GID=${PGID}"
        groupmod -g "${PGID}" "$APP_GROUP" > /dev/null
        needs_chown=true
    else
        e "> Group '$APP_GROUP' found with correct GID=${PGID} — skipping"
    fi

    if [[ -z "$current_uid" ]]; then
        e "> User '$APP_USER' not found — creating with UID=${PUID}"
        useradd -g "$APP_GROUP" -m -d "$APP_HOME" -s /bin/bash "$APP_USER" --uid "${PUID}"
        needs_chown=true
    elif [[ "$current_uid" -ne "${PUID}" ]]; then
        e "> User '$APP_USER' found with UID=${current_uid} — updating to UID=${PUID}"
        usermod -u "${PUID}" -g "${PGID}" "$APP_USER" > /dev/null
        needs_chown=true
    else
        e "> User '$APP_USER' found with correct UID=${PUID} — skipping"
    fi

    if [[ "$needs_chown" = "true" ]]; then
        # -xdev: stay on the same filesystem, skip bind mounts (avoids EPERM on :ro mounts)
        find "$APP_HOME" -xdev -exec chown "$APP_USER":"$APP_GROUP" {} +
        # Explicitly re-own bind-mounted data dirs that -xdev skips
        chown -R "$APP_USER":"$APP_GROUP" "$APP_HOME/.claude" 2>/dev/null || true
    fi
}
