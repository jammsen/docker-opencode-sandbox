#!/usr/bin/env bash
# Container entrypoint — runs once as root, sets up the environment, then
# execs WeTTY as the foreground process. Per-connection logic lives in
# agent-session.sh; the actual work is in /includes/*.sh, one file per concern.
set -euo pipefail
umask 0027

APP_USER=agent
APP_GROUP=agent
APP_HOME=/home/$APP_USER
readonly APP_USER APP_GROUP APP_HOME

source /includes/colors.sh
source /includes/security.sh
source /includes/model.sh
source /includes/user.sh
source /includes/config.sh
source /includes/tools.sh
source /includes/services.sh

check_root
check_puid_pgid
setup_model_env
setup_app_user
sync_claude_config
render_tool_templates
render_mcp_config
link_opencode_auth
check_workspace
detect_tools
start_upload_server
start_claude_shim
start_wetty
