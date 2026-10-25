/** Versioned, dependency-light helper installed under the remote user's home directory. */
export const DSH_SSH_HELPER_VERSION = 10

export const DSH_SSH_HELPER_SOURCE = String.raw`#!/usr/bin/env python3
import base64
import hashlib
import ipaddress
import json
import os
import pathlib
import shlex
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time
import uuid

try:
    import fcntl
except ImportError:
    fcntl = None

VERSION = 10
STATE = pathlib.Path.home() / '.dsh' / 'ssh-helper'
TERMINALS = STATE / 'terminals'

def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')
    sys.stdout.flush()

def fail(message, code=1):
    sys.stderr.write(str(message) + '\n')
    sys.stderr.flush()
    raise SystemExit(code)

def regular_info(path):
    try:
        value = os.lstat(path)
    except FileNotFoundError:
        return None
    if stat.S_ISREG(value.st_mode): kind = 'file'
    elif stat.S_ISDIR(value.st_mode): kind = 'directory'
    elif stat.S_ISLNK(value.st_mode): kind = 'symlink'
    else: kind = 'other'
    return {
        'kind': kind,
        'size': int(value.st_size),
        'mtimeMs': int(value.st_mtime_ns // 1000000),
        'mode': int(value.st_mode),
    }

def decode_json(value):
    if not value: return []
    padded = value + ('=' * ((4 - len(value) % 4) % 4))
    return json.loads(base64.urlsafe_b64decode(padded.encode('ascii')).decode('utf-8'))

def safe_terminal_id(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()[:32]

def terminal_paths(value):
    key = safe_terminal_id(value)
    directory = TERMINALS / key
    return key, directory, directory / 'output.log', directory / 'lease.json'

def tmux_session(key):
    return 'dsh-' + key[:20]

def tmux_exists(session):
    return subprocess.run(['tmux', 'has-session', '-t', session], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0

def tmux_status(session):
    if not tmux_exists(session): return None
    value = subprocess.run(
        ['tmux', 'list-panes', '-t', session, '-F', '#{pane_dead} #{pane_dead_status}'],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    ).stdout.strip().splitlines()
    if not value: return None
    parts = value[0].split()
    return {'alive': parts[0] == '0', 'exitCode': int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0}

def captured_delta(previous, current):
    if not previous: return current
    if current.startswith(previous): return current[len(previous):]
    old_lines = previous.splitlines(keepends=True)
    new_lines = current.splitlines(keepends=True)
    maximum = min(len(old_lines), len(new_lines))
    for count in range(maximum, 0, -1):
        if old_lines[-count:] == new_lines[:count]:
            return b''.join(new_lines[count:])
    return current

def capture_terminal(session, directory, log):
    captured = subprocess.run(
        ['tmux', 'capture-pane', '-p', '-e', '-S', '-100000', '-t', session],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    if captured.returncode != 0: return
    snapshot = directory / 'capture.snapshot'
    with open(directory / 'capture.lock', 'a+b') as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try: previous = snapshot.read_bytes()
        except FileNotFoundError: previous = b''
        delta = captured_delta(previous, captured.stdout)
        if delta:
            with open(log, 'ab') as target:
                target.write(delta)
                target.flush()
        temporary = directory / ('.capture-' + uuid.uuid4().hex)
        temporary.write_bytes(captured.stdout)
        os.replace(temporary, snapshot)
        fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

def cmd_probe(args):
    emit({
        'version': VERSION,
        'platform': sys.platform,
        'hostname': socket.gethostname(),
        'python': sys.version.split()[0],
        'tmux': shutil.which('tmux') is not None,
        'inotifywait': shutil.which('inotifywait') is not None,
        'ss': shutil.which('ss') is not None,
    })

def cmd_realpath(args):
    if len(args) != 1: fail('realpath requires one path')
    path = os.path.realpath(args[0])
    if not os.path.isdir(path): fail('remote directory does not exist')
    emit({'path': path})

def cmd_stat(args):
    if len(args) != 1: fail('stat requires one path')
    emit({'stat': regular_info(args[0])})

def cmd_resolve(args):
    if len(args) != 1: fail('resolve requires one path')
    path = os.path.realpath(args[0])
    if not os.path.exists(path): fail('remote path does not exist')
    emit({'path': path})

def cmd_list(args):
    if len(args) != 2: fail('list requires path and limit')
    path = os.path.realpath(args[0])
    limit = max(1, int(args[1]))
    if not os.path.isdir(path): fail('remote directory does not exist')
    with os.scandir(path) as source:
        rows = sorted(list(source), key=lambda item: item.name.casefold())
    for entry in rows[:limit + 1]:
        info = regular_info(entry.path)
        if info is not None: emit({'name': entry.name, **info})

def cmd_search(args):
    if len(args) != 4: fail('search requires root, query, limit and exclusions')
    root = os.path.realpath(args[0])
    query = args[1].casefold()
    limit = max(1, int(args[2]))
    count = 0
    for relative, info in iter_tree(root, set(decode_json(args[3]))):
        if query in os.path.basename(relative).casefold():
            emit({'path': relative, **info})
            count += 1
            if count > limit: break

def iter_tree(root, excludes):
    root = os.path.realpath(root)
    stack = [('', root)]
    while stack:
        relative, absolute = stack.pop()
        with os.scandir(absolute) as rows:
            entries = sorted(list(rows), key=lambda item: item.name, reverse=True)
        for entry in entries:
            if entry.name in excludes or entry.name.startswith('.dsh-sync-'):
                continue
            child_relative = entry.name if not relative else relative + '/' + entry.name
            info = regular_info(entry.path)
            if info is None: continue
            yield child_relative, info
            if info['kind'] == 'directory':
                stack.append((child_relative, entry.path))

def cmd_scan(args):
    if len(args) != 2: fail('scan requires root and exclusions')
    for relative, info in iter_tree(args[0], set(decode_json(args[1]))):
        emit({'path': relative, **info})

def cmd_hash(args):
    if len(args) != 1: fail('hash requires one path')
    path = args[0]
    before = os.stat(path, follow_symlinks=False)
    if not stat.S_ISREG(before.st_mode): fail('not a regular file')
    digest = hashlib.sha256()
    size = 0
    with open(path, 'rb', buffering=1024 * 1024) as source:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk: break
            digest.update(chunk)
            size += len(chunk)
    after = os.stat(path, follow_symlinks=False)
    if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns or size != before.st_size:
        fail('file changed while hashing', 75)
    emit({'hash': digest.hexdigest(), 'size': size})

def cmd_read(args):
    if len(args) != 1: fail('read requires one path')
    path = args[0]
    before = os.stat(path, follow_symlinks=False)
    if not stat.S_ISREG(before.st_mode): fail('not a regular file')
    with open(path, 'rb', buffering=1024 * 1024) as source:
        shutil.copyfileobj(source, sys.stdout.buffer, length=1024 * 1024)
    sys.stdout.buffer.flush()
    after = os.stat(path, follow_symlinks=False)
    if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
        fail('file changed while reading', 75)

def cmd_read_head(args):
    if len(args) != 2: fail('read-head requires path and maximum size')
    path = args[0]
    maximum = max(0, int(args[1]))
    before = os.stat(path, follow_symlinks=False)
    if not stat.S_ISREG(before.st_mode): fail('not a regular file')
    with open(path, 'rb', buffering=1024 * 1024) as source:
        remaining = maximum
        while remaining > 0:
            chunk = source.read(min(1024 * 1024, remaining))
            if not chunk: break
            sys.stdout.buffer.write(chunk)
            remaining -= len(chunk)
    sys.stdout.buffer.flush()
    after = os.stat(path, follow_symlinks=False)
    if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
        fail('file changed while reading', 75)

def cmd_read_range(args):
    if len(args) != 3: fail('read-range requires path, offset, and length')
    path = args[0]
    offset = max(0, int(args[1]))
    length = max(0, int(args[2]))
    before = os.stat(path, follow_symlinks=False)
    if not stat.S_ISREG(before.st_mode): fail('not a regular file')
    with open(path, 'rb', buffering=1024 * 1024) as source:
        source.seek(offset)
        remaining = min(length, max(0, before.st_size - offset))
        while remaining > 0:
            chunk = source.read(min(1024 * 1024, remaining))
            if not chunk: break
            sys.stdout.buffer.write(chunk)
            remaining -= len(chunk)
    sys.stdout.buffer.flush()
    after = os.stat(path, follow_symlinks=False)
    if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
        fail('file changed while reading', 75)

def cmd_write(args):
    if len(args) != 2: fail('write requires path and maximum size')
    path = os.path.abspath(args[0])
    maximum = int(args[1])
    parent = os.path.dirname(path)
    os.makedirs(parent, exist_ok=True)
    existing = regular_info(path)
    fd, temporary = tempfile.mkstemp(prefix='.dsh-upload-', dir=parent)
    digest = hashlib.sha256()
    size = 0
    try:
        with os.fdopen(fd, 'wb', buffering=1024 * 1024) as target:
            while True:
                chunk = sys.stdin.buffer.read(1024 * 1024)
                if not chunk: break
                size += len(chunk)
                if size > maximum: fail('file exceeds transfer limit', 76)
                digest.update(chunk)
                target.write(chunk)
            target.flush()
            os.fsync(target.fileno())
        os.chmod(temporary, (existing['mode'] & 0o777) if existing and existing['kind'] == 'file' else 0o600)
        os.replace(temporary, path)
        # Persist the rename itself where the platform supports directory
        # handles. Windows rejects opening a directory this way, while some
        # remote filesystems reject fsync even after the open succeeds. The
        # file data above has already been fsynced, so either limitation is a
        # safe durability downgrade instead of a failed upload.
        directory_fd = None
        try:
            directory_fd = os.open(parent, os.O_RDONLY)
            os.fsync(directory_fd)
        except OSError:
            pass
        finally:
            if directory_fd is not None: os.close(directory_fd)
        emit({'hash': digest.hexdigest(), 'size': size, 'stat': regular_info(path)})
    finally:
        try: os.unlink(temporary)
        except FileNotFoundError: pass

def cmd_mkdir(args):
    if len(args) != 1: fail('mkdir requires one path')
    os.makedirs(args[0], exist_ok=True)
    if not os.path.isdir(args[0]): fail('path is not a directory')

def cmd_unlink(args):
    if len(args) != 1: fail('unlink requires one path')
    try: os.unlink(args[0])
    except FileNotFoundError: pass

def cmd_remove(args):
    if len(args) != 2: fail('remove requires path and recursive flag')
    path = args[0]
    info = regular_info(path)
    if info is None: return
    if info['kind'] == 'directory':
        if args[1] != '1': os.rmdir(path)
        else: shutil.rmtree(path)
    else:
        os.unlink(path)

def cmd_rename(args):
    if len(args) != 2: fail('rename requires source and destination')
    os.makedirs(os.path.dirname(os.path.abspath(args[1])), exist_ok=True)
    os.replace(args[0], args[1])

def snapshot(root, excludes):
    digest = hashlib.sha256()
    for relative, info in iter_tree(root, excludes):
        digest.update(relative.encode('utf-8', 'surrogateescape'))
        digest.update(b'\0')
        digest.update(str(info['size']).encode())
        digest.update(b':')
        digest.update(str(info['mtimeMs']).encode())
        digest.update(b':')
        digest.update(info['kind'].encode())
        digest.update(b'\n')
    return digest.hexdigest()

def cmd_watch_poll(root, excludes, interval):
    previous = snapshot(root, excludes)
    emit({'type': 'ready', 'backend': 'poll'})
    while True:
        time.sleep(interval)
        current = snapshot(root, excludes)
        if current != previous:
            previous = current
            emit({'type': 'change'})

def cmd_watch_inotify(root, excludes):
    process = subprocess.Popen([
        'inotifywait', '-m', '-r', '-q',
        '-e', 'close_write,create,delete,move,attrib', '--format', '%w%f', root,
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='replace')
    emit({'type': 'ready', 'backend': 'inotify'})
    assert process.stdout is not None
    for line in process.stdout:
        candidate = os.path.relpath(line.rstrip('\n'), root).replace(os.sep, '/')
        if any(part in excludes or part.startswith('.dsh-sync-') for part in candidate.split('/')):
            continue
        emit({'type': 'change', 'path': candidate})
    raise SystemExit(process.wait())

def cmd_watch(args):
    if len(args) != 3: fail('watch requires root, exclusions, and interval')
    root = os.path.realpath(args[0])
    excludes = set(decode_json(args[1]))
    interval = max(0.5, min(60.0, float(args[2])))
    if shutil.which('inotifywait'):
        cmd_watch_inotify(root, excludes)
    cmd_watch_poll(root, excludes, interval)

def decode_proc_address(value, ipv6):
    raw_host, raw_port = value.split(':')
    port = int(raw_port, 16)
    packed = bytes.fromhex(raw_host)
    if ipv6:
        host = str(ipaddress.IPv6Address(b''.join(packed[i:i+4][::-1] for i in range(0, 16, 4))))
    else:
        host = socket.inet_ntoa(packed[::-1])
    return host, port

def cmd_ports(args):
    found = set()
    if shutil.which('ss'):
        result = subprocess.run(
            ['ss', '-H', '-ltnp'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding='utf-8', errors='replace',
        )
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                parts = line.split(None, 5)
                if len(parts) < 4: continue
                endpoint = parts[3]
                host, separator, port_value = endpoint.rpartition(':')
                if not separator or not port_value.isdigit(): continue
                host = host.strip('[]')
                if host == '*': host = '0.0.0.0'
                port = int(port_value)
                if not port or (host, port) in found: continue
                found.add((host, port))
                process = parts[5].strip() if len(parts) > 5 else ''
                emit({'host': host, 'port': port, **({'process': process[:512]} if process else {})})
            # ss has the authoritative socket view and also supplies process
            # labels when the remote account is allowed to see them.
            return
    for filename, ipv6 in [('/proc/net/tcp', False), ('/proc/net/tcp6', True)]:
        try:
            with open(filename, 'r', encoding='ascii') as source:
                next(source, None)
                for line in source:
                    parts = line.split()
                    if len(parts) < 4 or parts[3] != '0A': continue
                    host, port = decode_proc_address(parts[1], ipv6)
                    if port and (host, port) not in found:
                        found.add((host, port))
                        emit({'host': host, 'port': port})
        except FileNotFoundError:
            continue

def cmd_terminal_start(args):
    if len(args) != 4: fail('terminal-start requires id, cwd, cols, rows')
    if not shutil.which('tmux'): fail('tmux is unavailable', 69)
    terminal_id, cwd, cols, rows = args
    key, directory, log, lease = terminal_paths(terminal_id)
    directory.mkdir(parents=True, exist_ok=True)
    try: lease.unlink()
    except FileNotFoundError: pass
    session = tmux_session(key)
    status = tmux_status(session)
    if status is not None and not status['alive']:
        subprocess.run(['tmux', 'kill-session', '-t', session], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        status = None
    if status is None:
        log.write_bytes(b'')
        try: (directory / 'capture.snapshot').unlink()
        except FileNotFoundError: pass
        subprocess.run(['tmux', 'start-server'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['tmux', 'set-option', '-g', 'history-limit', '100000'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        size_args = ['-x', str(max(2, int(cols))), '-y', str(max(2, int(rows)))]
        result = subprocess.run(['tmux', 'new-session', '-d', '-s', session, *size_args, '-c', cwd], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode != 0:
            subprocess.run(['tmux', 'kill-session', '-t', session], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            login = 'cd -- ' + shlex.quote(cwd) + ' && exec "$' + '{SHELL:-/bin/sh}" -l'
            result = subprocess.run(['tmux', 'new-session', '-d', '-s', session, *size_args, login], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode != 0: fail('failed to create tmux session')
        subprocess.run(['tmux', 'set-option', '-t', session, 'remain-on-exit', 'on'], check=False)
    emit({'session': session, 'offset': log.stat().st_size if log.exists() else 0})

def cmd_terminal_follow(args):
    if len(args) != 2: fail('terminal-follow requires id and offset')
    terminal_id, offset_value = args
    key, directory, log, lease = terminal_paths(terminal_id)
    session = tmux_session(key)
    offset = max(0, int(offset_value))
    idle_after_exit = 0
    while True:
        capture_terminal(session, directory, log)
        if log.exists():
            with open(log, 'rb') as source:
                source.seek(min(offset, log.stat().st_size))
                while True:
                    chunk = source.read(64 * 1024)
                    if not chunk: break
                    sys.stdout.buffer.write(chunk)
                    sys.stdout.buffer.flush()
                    offset += len(chunk)
        status = tmux_status(session)
        if status is None or not status['alive']:
            idle_after_exit += 1
            if idle_after_exit >= 4:
                exit_code = 0 if status is None else status['exitCode']
                sys.stderr.write('__DSH_TERMINAL_EXIT__=' + str(exit_code) + '\n')
                sys.stderr.flush()
                return
        else:
            idle_after_exit = 0
        time.sleep(0.25)

def cmd_terminal_input(args):
    if len(args) != 2: fail('terminal-input requires id and sequence')
    terminal_id, sequence_value = args
    sequence = int(sequence_value)
    key, directory, log, lease = terminal_paths(terminal_id)
    session = tmux_session(key)
    status = tmux_status(session)
    if status is None or not status['alive']: fail('terminal is not running', 70)
    sequence_file = directory / 'input-sequence'
    try: previous = int(sequence_file.read_text(encoding='ascii'))
    except (FileNotFoundError, ValueError): previous = 0
    if sequence <= previous: return
    buffer_name = 'dsh-' + uuid.uuid4().hex
    input_file = directory / ('.terminal-input-' + uuid.uuid4().hex)
    with open(input_file, 'wb') as target:
        shutil.copyfileobj(sys.stdin.buffer, target, length=1024 * 1024)
        target.flush()
        os.fsync(target.fileno())
    loaded = subprocess.run(['tmux', 'load-buffer', '-b', buffer_name, str(input_file)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if loaded.returncode == 0:
        pasted = subprocess.run(['tmux', 'paste-buffer', '-d', '-b', buffer_name, '-t', session])
    else:
        # tmux 1.8 only accepts numeric global buffer indexes. Serialize use
        # of its default buffer so simultaneous DSH terminals cannot mix input.
        if fcntl is None: fail('legacy tmux input locking is unavailable')
        with open(STATE / 'terminal-input.lock', 'a+b') as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            loaded = subprocess.run(['tmux', 'load-buffer', str(input_file)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            pasted = subprocess.run(['tmux', 'paste-buffer', '-d', '-t', session]) if loaded.returncode == 0 else loaded
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
    try: input_file.unlink()
    except FileNotFoundError: pass
    if loaded.returncode != 0: fail('failed to load terminal input')
    if pasted.returncode != 0: fail('failed to deliver terminal input')
    temporary = directory / ('.input-sequence-' + uuid.uuid4().hex)
    temporary.write_text(str(sequence), encoding='ascii')
    os.replace(temporary, sequence_file)

def cmd_terminal_resize(args):
    if len(args) != 3: fail('terminal-resize requires id, cols, rows')
    key, directory, log, lease = terminal_paths(args[0])
    session = tmux_session(key)
    if tmux_exists(session):
        subprocess.run(['tmux', 'resize-window', '-t', session, '-x', str(max(2, int(args[1]))), '-y', str(max(2, int(args[2])))], check=False)

def cmd_terminal_close(args):
    if len(args) != 1: fail('terminal-close requires id')
    key, directory, log, lease = terminal_paths(args[0])
    subprocess.run(['tmux', 'kill-session', '-t', tmux_session(key)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    shutil.rmtree(directory, ignore_errors=True)

def cmd_terminal_detach(args):
    if len(args) != 2: fail('terminal-detach requires id and grace')
    terminal_id, grace_value = args
    key, directory, log, lease = terminal_paths(terminal_id)
    if not tmux_exists(tmux_session(key)): return
    grace = max(30, min(86400, int(grace_value)))
    token = uuid.uuid4().hex
    directory.mkdir(parents=True, exist_ok=True)
    lease.write_text(json.dumps({'token': token, 'deadline': time.time() + grace}), encoding='utf-8')
    subprocess.Popen(
        [sys.executable, os.path.realpath(__file__), 'terminal-reap', terminal_id, token, str(grace)],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
    )

def cmd_terminal_reap(args):
    if len(args) != 3: return
    terminal_id, token, grace_value = args
    time.sleep(max(1, int(grace_value)))
    key, directory, log, lease = terminal_paths(terminal_id)
    try: value = json.loads(lease.read_text(encoding='utf-8'))
    except (FileNotFoundError, ValueError): return
    if value.get('token') != token: return
    subprocess.run(['tmux', 'kill-session', '-t', tmux_session(key)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    shutil.rmtree(directory, ignore_errors=True)

COMMANDS = {
    'probe': cmd_probe,
    'realpath': cmd_realpath,
    'stat': cmd_stat,
    'resolve': cmd_resolve,
    'list': cmd_list,
    'search': cmd_search,
    'scan': cmd_scan,
    'hash': cmd_hash,
    'read': cmd_read,
    'read-head': cmd_read_head,
    'read-range': cmd_read_range,
    'write': cmd_write,
    'mkdir': cmd_mkdir,
    'unlink': cmd_unlink,
    'remove': cmd_remove,
    'rename': cmd_rename,
    'watch': cmd_watch,
    'ports': cmd_ports,
    'terminal-start': cmd_terminal_start,
    'terminal-follow': cmd_terminal_follow,
    'terminal-input': cmd_terminal_input,
    'terminal-resize': cmd_terminal_resize,
    'terminal-close': cmd_terminal_close,
    'terminal-detach': cmd_terminal_detach,
    'terminal-reap': cmd_terminal_reap,
}

def main():
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        fail('unsupported helper command')
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    TERMINALS.mkdir(parents=True, exist_ok=True, mode=0o700)
    COMMANDS[sys.argv[1]](sys.argv[2:])

if __name__ == '__main__':
    main()
`
