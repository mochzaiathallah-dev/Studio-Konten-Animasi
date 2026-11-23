"""Antrekan ulang job VO yang gagal (sekali pakai, jalan di box worker).

Dibaca dari .env box (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) — key
tidak pernah keluar dari box ini.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from supabase import create_client

url = os.environ["SUPABASE_URL"]
key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
sb = create_client(url, key)
res = (
    sb.table("jobs")
    .update({"status": "queued", "error": None})
    .eq("status", "failed")
    .execute()
)
print("requeued:", len(res.data))
for row in res.data:
    print(" -", row["id"], row.get("text", "")[:60])
