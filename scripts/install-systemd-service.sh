#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Please run as root."
  exit 1
fi

COPILOT_TRANSPORT_OVERRIDE=""
if [[ $# -gt 0 ]]; then
  case "$1" in
    --copilot-transport=direct) COPILOT_TRANSPORT_OVERRIDE="direct" ;;
    --copilot-transport=bridge) COPILOT_TRANSPORT_OVERRIDE="bridge" ;;
    *) echo "Usage: $0 [--copilot-transport=direct|bridge]"; exit 1 ;;
  esac
  if [[ $# -ne 1 ]]; then
    echo "Usage: $0 [--copilot-transport=direct|bridge]"
    exit 1
  fi
fi

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_SRC="${PROJECT_DIR}/deploy/codexproxy.service"
SERVICE_DEST="/etc/systemd/system/codexproxy.service"
COPILOT_SERVICE_SRC="${PROJECT_DIR}/deploy/copilot-proxy-api.service"
COPILOT_SERVICE_DEST="/etc/systemd/system/copilot-proxy-api.service"
ENV_EXAMPLE="${PROJECT_DIR}/deploy/codexproxy.env.example"
ENV_DEST="/etc/default/codexproxy"

PROJECT_OWNER="$(stat -c '%U' "${PROJECT_DIR}")"
PROJECT_GROUP="$(stat -c '%G' "${PROJECT_DIR}")"
PROJECT_HOME="$(getent passwd "${PROJECT_OWNER}" | cut -d: -f6)"
if [[ -z "${PROJECT_HOME}" || ! -d "${PROJECT_HOME}" ]]; then
  echo "Cannot determine home directory for ${PROJECT_OWNER}."
  exit 1
fi

NVM_NODE=""
if [[ "${PROJECT_OWNER}" != "root" && -d "${PROJECT_HOME}/.nvm/versions/node" ]]; then
  NVM_NODE="$(find "${PROJECT_HOME}/.nvm/versions/node" -path '*/bin/node' -type f -executable | sort -V | tail -n 1)"
fi

NODE_BIN="${NVM_NODE:-$(command -v node || true)}"
if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  echo "Cannot find an executable node in PATH."
  echo "Install Node.js first, then retry."
  exit 1
fi

install -D -m 0644 /dev/null "${SERVICE_DEST}"
PROJECT_DIR_ESCAPED="${PROJECT_DIR//&/\\&}"
PROJECT_OWNER_ESCAPED="${PROJECT_OWNER//&/\\&}"
PROJECT_GROUP_ESCAPED="${PROJECT_GROUP//&/\\&}"
PROJECT_HOME_ESCAPED="${PROJECT_HOME//&/\\&}"
NODE_BIN_DIR_ESCAPED="${NODE_BIN%/*}"
NODE_BIN_DIR_ESCAPED="${NODE_BIN_DIR_ESCAPED//&/\\&}"
sed \
  -e "s|__PROJECT_DIR__|${PROJECT_DIR_ESCAPED}|g" \
  -e "s|__PROJECT_OWNER__|${PROJECT_OWNER_ESCAPED}|g" \
  -e "s|__PROJECT_GROUP__|${PROJECT_GROUP_ESCAPED}|g" \
  -e "s|__PROJECT_HOME__|${PROJECT_HOME_ESCAPED}|g" \
  -e "s|__NODE_BIN_DIR__|${NODE_BIN_DIR_ESCAPED}|g" \
  "${SERVICE_SRC}" > "${SERVICE_DEST}"
chmod 0644 "${SERVICE_DEST}"

install -D -m 0644 /dev/null "${COPILOT_SERVICE_DEST}"
sed \
  -e "s|__PROJECT_DIR__|${PROJECT_DIR_ESCAPED}|g" \
  -e "s|__PROJECT_OWNER__|${PROJECT_OWNER_ESCAPED}|g" \
  -e "s|__PROJECT_GROUP__|${PROJECT_GROUP_ESCAPED}|g" \
  -e "s|__PROJECT_HOME__|${PROJECT_HOME_ESCAPED}|g" \
  -e "s|__NODE_BIN_DIR__|${NODE_BIN_DIR_ESCAPED}|g" \
  -e "s|__NODE_BIN__|${NODE_BIN}|g" \
  "${COPILOT_SERVICE_SRC}" > "${COPILOT_SERVICE_DEST}"
chmod 0644 "${COPILOT_SERVICE_DEST}"

if [[ ! -f "${ENV_DEST}" ]]; then
  install -D -m 0644 "${ENV_EXAMPLE}" "${ENV_DEST}"
  sed -i "s|^NODE_BIN=.*|NODE_BIN=${NODE_BIN}|" "${ENV_DEST}"
  echo "Created ${ENV_DEST}"
else
  if grep -q "^NODE_BIN=" "${ENV_DEST}"; then
    sed -i "s|^NODE_BIN=.*|NODE_BIN=${NODE_BIN}|" "${ENV_DEST}"
    echo "Updated NODE_BIN in ${ENV_DEST}"
  else
    echo "NODE_BIN=${NODE_BIN}" >> "${ENV_DEST}"
    echo "Added NODE_BIN to ${ENV_DEST}"
  fi
fi

if [[ -n "${COPILOT_TRANSPORT_OVERRIDE}" ]]; then
  if grep -q "^COPILOT_TRANSPORT=" "${ENV_DEST}"; then
    sed -i "s|^COPILOT_TRANSPORT=.*|COPILOT_TRANSPORT=${COPILOT_TRANSPORT_OVERRIDE}|" "${ENV_DEST}"
  else
    echo "COPILOT_TRANSPORT=${COPILOT_TRANSPORT_OVERRIDE}" >> "${ENV_DEST}"
  fi
fi

if grep -q '^COPILOT_PROXY_API_KEY=.' "${ENV_DEST}"; then
  chmod 0600 "${ENV_DEST}"
fi

systemctl daemon-reload
systemctl enable codexproxy.service
systemctl restart codexproxy.service

echo
echo "Service enabled and started."
echo "Bridge unit installed; this script does not enable, disable, start, or stop the bridge."
systemctl --no-pager --full status codexproxy.service | sed -n '1,20p'
