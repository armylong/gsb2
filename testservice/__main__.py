import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from testservice.server import serve, DEFAULT_PORT

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="本机模糊测试用测试服务")
    parser.add_argument("-p", "--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    serve(args.port, args.host)
