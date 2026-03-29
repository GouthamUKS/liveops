"""
docker_ctrl.py — Container lifecycle management via the Docker SDK.

Uses compose service labels to find containers without needing to know
the project name (which varies by directory name).
"""

import logging

logger = logging.getLogger(__name__)


def _client():
    import docker
    return docker.from_env()


def _find(service_name: str, running_only: bool = True) -> list:
    """Return containers matching a docker-compose service label."""
    client = _client()
    return client.containers.list(
        all=not running_only,
        filters={"label": f"com.docker.compose.service={service_name}"},
    )


def stop_container(service_name: str) -> dict:
    """Stop all running containers for the given compose service."""
    try:
        containers = _find(service_name, running_only=True)
        if not containers:
            return {"ok": False, "error": f"No running container for service '{service_name}'"}

        for c in containers:
            logger.info("Stopping container %s (%s)", c.name, c.short_id)
            c.stop(timeout=10)

        return {"ok": True, "stopped": len(containers)}
    except Exception as exc:
        logger.exception("stop_container failed for %s", service_name)
        return {"ok": False, "error": str(exc)}


def start_container(service_name: str) -> dict:
    """Start stopped containers for the given compose service."""
    try:
        # Include stopped containers in the search
        containers = _find(service_name, running_only=False)
        if not containers:
            return {"ok": False, "error": f"No container found for service '{service_name}'"}

        started = 0
        for c in containers:
            if c.status != "running":
                logger.info("Starting container %s (%s)", c.name, c.short_id)
                c.start()
                started += 1

        return {"ok": True, "started": started, "already_running": len(containers) - started}
    except Exception as exc:
        logger.exception("start_container failed for %s", service_name)
        return {"ok": False, "error": str(exc)}


def container_status(service_name: str) -> dict:
    """Return status of containers for a service."""
    try:
        containers = _find(service_name, running_only=False)
        return {
            "service": service_name,
            "containers": [
                {"id": c.short_id, "name": c.name, "status": c.status}
                for c in containers
            ],
        }
    except Exception as exc:
        return {"service": service_name, "error": str(exc)}
