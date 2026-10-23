"""SSH 输出回归检查：服务器先发退出状态、后发最后一段输出。无网络连接。"""

import importlib.util
from pathlib import Path
import threading
import unittest


runner = Path(__file__).resolve().parents[1] / "tools/test-server.py"
spec = importlib.util.spec_from_file_location("server_test_runner", runner)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class LateOutputChannel:
    def __init__(self):
        self.closed = False
        self.eof_received = False
        self.output = b""
        self.errors = b""
        self.timer = None

    def exec_command(self, command):
        self.timer = threading.Timer(0.02, self.finish_output)
        self.timer.start()

    def finish_output(self):
        self.output = b"late stdout\n"
        self.errors = b"late stderr\n"
        self.eof_received = True

    def exit_status_ready(self):
        return True

    def recv_ready(self):
        return bool(self.output)

    def recv_stderr_ready(self):
        return bool(self.errors)

    def recv(self, size):
        data, self.output = self.output, b""
        return data

    def recv_stderr(self, size):
        data, self.errors = self.errors, b""
        return data

    def recv_exit_status(self):
        return 7

    def close(self):
        self.closed = True
        if self.timer:
            self.timer.cancel()


class FakeClient:
    def __init__(self, channel):
        self.channel = channel

    def get_transport(self):
        return self

    def open_session(self, timeout):
        return self.channel


class OutputTests(unittest.TestCase):
    def test_late_stdout_and_stderr_are_collected(self):
        channel = LateOutputChannel()
        result = module.execute(FakeClient(channel), "unused", timeout=2)
        self.assertEqual(result["stdout"], "late stdout\n")
        self.assertEqual(result["stderr"], "late stderr\n")
        self.assertEqual(result["exit_code"], 7)
        self.assertTrue(channel.closed)

    def test_missing_eof_times_out_and_closes_channel(self):
        channel = LateOutputChannel()
        channel.exec_command = lambda command: None
        with self.assertRaises(TimeoutError):
            module.execute(FakeClient(channel), "unused", timeout=0.02)
        self.assertTrue(channel.closed)


if __name__ == "__main__":
    unittest.main()
