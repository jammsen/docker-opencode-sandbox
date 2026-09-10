# Privilege and identity checks — must pass before any setup work runs.

check_root() {
    # https://stackoverflow.com/questions/27669950/difference-between-euid-and-uid
    if [[ "${EUID}" -ne 0 ]]; then
        ee ">>> [Entrypoint] Requires root to run setup (creating users, fixing file ownership)."
        ee "    The container process is currently running as EUID=${EUID}. Please start the container without a --user override."
        exit 1
    fi
}

check_puid_pgid() {
    # Positive integers only — running the application user as root is not supported;
    # this container is designed to drop privileges after setup.
    if ! [[ "${PUID:-}" =~ ^[1-9][0-9]*$ ]] || ! [[ "${PGID:-}" =~ ^[1-9][0-9]*$ ]]; then
        ee ">>> [Config] PUID=${PUID:-<unset>} PGID=${PGID:-<unset>} — Must be positive integers"
        ee "    Please set positive integer values for PUID and PGID."
        exit 1
    fi
}
