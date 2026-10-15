"""Official app-server stdio client. This module never starts a model turn."""
import json
import os
import queue
import subprocess
import threading
import time


class RPC:
    def __init__(self, binary, home=None, timeout=30, deadline=None):
        self.timeout = timeout
        self.deadline = deadline
        environment = os.environ.copy()
        if home:
            environment['CODEX_HOME'] = home
        self.process = subprocess.Popen([binary, 'app-server', '--listen', 'stdio://'], env=environment,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                        text=True, bufsize=1)
        self.messages = queue.Queue()
        self.sequence = 0

        def read():
            for line in self.process.stdout:
                try:
                    self.messages.put(json.loads(line))
                except ValueError:
                    pass
            self.messages.put(None)
        self.reader = threading.Thread(target=read, daemon=True)
        self.reader.start()

    def __enter__(self):
        try:
            self.call('initialize', {'clientInfo': {'name': 'cloud_dispatch_bridge', 'version': '1.0'},
                                     'capabilities': {'experimentalApi': True}})
            self.send({'method': 'initialized', 'params': {}})
            return self
        except BaseException:
            self.close()
            raise

    def __exit__(self, *args):
        self.close()

    def send(self, message):
        self.process.stdin.write(json.dumps(message) + '\n')
        self.process.stdin.flush()

    def call(self, method, params=None, timeout=None):
        self.sequence += 1
        request_id = self.sequence
        self.send({'id': request_id, 'method': method, 'params': params or {}})
        deadline = time.monotonic()+(self.timeout if timeout is None else timeout)
        if self.deadline is not None:
            deadline = min(deadline, self.deadline)
        while time.monotonic() < deadline:
            response = self.messages.get(timeout=max(.1, deadline-time.monotonic()))
            if response is None:
                raise RuntimeError('app-server stdout closed')
            if 'id' in response and 'method' in response:
                self.send({'id': response['id'], 'error': {'code': -32601, 'message': 'Bridge does not execute tools'}})
            if response.get('id') == request_id and 'method' not in response:
                if 'error' in response:
                    raise RuntimeError(method + ' failed (JSON-RPC ' + str(response['error'].get('code')) + ')')
                return response['result']
        raise TimeoutError(method)

    def close(self):
        if self.process.poll() is None:
            try:
                self.process.stdin.close()
                self.process.wait(timeout=3)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                self.process.terminate()
                try:
                    self.process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
        self.reader.join(timeout=1)
        for stream in (self.process.stdin, self.process.stdout):
            try:
                stream.close()
            except (BrokenPipeError, OSError):
                pass
