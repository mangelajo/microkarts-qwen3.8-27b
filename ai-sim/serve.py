"""Dev server with no-cache headers (plain `http.server` caches in some browsers).
Usage: python3 ai-sim/serve.py [port]  (default 8080)
"""
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler


class NoCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    print(f'micro-kart dev server: http://localhost:{port} (no-cache)')
    HTTPServer(('', port), NoCache).serve_forever()
