"""Participating native CLI launcher. No credentials or prompt inspection.

Invocation: native-launcher.py PERSISTENT_DATA_DIR ABSOLUTE_REAL_CLI [ARGS...]
The private persistent directory and its lock inode must never be replaced
while enrolled. Ordinary owner SSH remains unrestricted.
"""
import fcntl
import os
import json
import sys

storage, executable, *arguments = sys.argv[1:]
if not os.path.isabs(executable) or not os.path.isabs(storage):
    raise SystemExit("Absolute worker storage and real CLI paths required")
fd = os.open(os.path.join(storage, "native.lock"),
             os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print('{"error":"CELL_BUSY"}', file=sys.stderr)
    raise SystemExit(75)
os.set_inheritable(fd, True)
stat = os.fstat(fd)
receipt = {"pid": os.getpid(), "start": open(f"/proc/{os.getpid()}/stat").read().rsplit(")", 1)[1].split()[19],
           "boot": open("/proc/sys/kernel/random/boot_id").read().strip(),
           "inode": stat.st_ino, "device": stat.st_dev, "threadId": os.environ.get("BB_THREAD_ID")}
receipt_path = os.path.join(storage, "native-holder.json")
temporary = receipt_path + f".{os.getpid()}.tmp"
with open(temporary, "w", opener=lambda p, flags: os.open(p, flags, 0o600)) as output:
    json.dump(receipt, output)
os.replace(temporary, receipt_path)
for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
             "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_OAUTH_TOKEN",
             "BB_ACCOUNT_POOL_PARENT_URL", "BB_ACCOUNT_POOL_PARENT_TOKEN",
             "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE",
             "CODEX_OPENAI_BASE_URL", "CODEX_POOL_AUTH_TOKEN"):
    os.environ.pop(name, None)
os.execv(executable, [executable, *arguments])
