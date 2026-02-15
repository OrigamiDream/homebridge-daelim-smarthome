import subprocess
import shlex
import os
import getpass
import sys


def run_simple_command(command: str, *, stdin_text: str | None = None, label: str | None = None) -> str:
    if label:
        print(f"[{label}]")

    out = subprocess.run(command, shell=True, capture_output=True, text=True, input=stdin_text)

    # Print command output instead of echoing the command itself.
    if out.stdout:
        sys.stdout.write(out.stdout)
        if not out.stdout.endswith("\n"):
            sys.stdout.write("\n")
    if out.stderr:
        sys.stderr.write(out.stderr)
        if not out.stderr.endswith("\n"):
            sys.stderr.write("\n")

    if out.returncode != 0:
        raise RuntimeError(
            "Command failed (exit {code}): {cmd}\n\nSTDOUT:\n{stdout}\n\nSTDERR:\n{stderr}\n".format(
                code=out.returncode,
                cmd=command,
                stdout=(out.stdout or "").rstrip(),
                stderr=(out.stderr or "").rstrip(),
            )
        )
    return str(out.stdout).strip()


def get_sudo_password(host: str) -> str:
    # Preferred: non-interactive via env var.
    pw = os.environ.get("HOMEBRIDGE_VM_SUDO_PASSWORD")
    if pw is not None:
        return pw

    # Interactive: prompt without echo (best UX/security).
    if sys.stdin.isatty():
        return getpass.getpass(f"[{host}] sudo password for 'admin': ")

    # If we cannot prompt, fail fast with actionable instructions.
    raise RuntimeError(
        "Sudo password required but no TTY available to prompt.\n"
        "Re-run in an interactive terminal, or set HOMEBRIDGE_VM_SUDO_PASSWORD in the environment."
    )


def main():
    filename = run_simple_command("npm pack", label="npm pack")
    filename = filename.split("\n")[-1]

    host = "homebridge-vm.local"
    ssh = f"ssh admin@{host}"

    filename_q = shlex.quote(filename)
    remote_src = f"/home/admin/{filename}"
    remote_dst = f"/var/lib/homebridge/{filename}"

    # 1) Upload tarball to admin's home dir.
    run_simple_command(f"scp {filename_q} admin@{host}:/home/admin/", label="scp")

    # 2) Become root, then:
    # - copy it somewhere the 'homebridge' user can read
    # - run npm with the same runtime env hb-shell would set up (npm is available only in that env)
    root_script = "\n".join(
        [
            "set -e",
            f"install -o homebridge -g homebridge -m 0644 {shlex.quote(remote_src)} {shlex.quote(remote_dst)}",
            # hb-shell normally drops into the 'homebridge' user and sources /opt/homebridge/source.sh
            # (via /opt/homebridge/bashrc-hb-shell). When hb-shell is not interactive, bash may skip the rcfile,
            # so we explicitly source source.sh here.
            "sudo -u homebridge env HOME=/var/lib/homebridge bash -lc "
            + shlex.quote(
                f"cd /var/lib/homebridge && . /opt/homebridge/source.sh && npm install {shlex.quote(remote_dst)}"
            ),
            # Optional (disabled by default): restart Homebridge to pick up the new plugin immediately.
            # "hb-service restart",
        ]
    )

    # First try passwordless sudo (admin may have NOPASSWD for hb-* tooling).
    try:
        remote_cmd = f"sudo -n bash -lc {shlex.quote(root_script)}"
        run_simple_command(f"{ssh} {shlex.quote(remote_cmd)}", label="remote (sudo -n)")
    except RuntimeError as e:
        msg = str(e)
        needs_pw = (
            "sudo: a password is required" in msg
            or "sudo: a terminal is required" in msg
            or "a password is required" in msg
        )
        if not needs_pw:
            raise

        sudo_pw = get_sudo_password(host)

        remote_cmd = f"sudo -S -p '' bash -lc {shlex.quote(root_script)}"
        run_simple_command(
            f"{ssh} {shlex.quote(remote_cmd)}",
            stdin_text=sudo_pw + "\n",
            label="remote (sudo -S)",
        )

    run_simple_command(f"rm -f {filename_q}", label="cleanup")


if __name__ == '__main__':
    main()
