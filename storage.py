"""Conversation persistence for Tarjem.

Each user (identified by a random key the browser generates) owns a set of
conversation documents plus one index file listing them. Two backends:

- LocalStore: JSON files under data/<user>/  (fine on a PC; wiped on Render redeploys)
- SupabaseStore: same layout inside a private Supabase Storage bucket, which
  survives redeploys. Needs SUPABASE_URL + SUPABASE_SERVICE_KEY; no tables, no SQL.
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import time

import requests

log = logging.getLogger("tarjem.storage")

USER_RE = re.compile(r"^[A-Za-z0-9_-]{8,48}$")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{4,48}$")
MAX_DOC_BYTES = 2 * 1024 * 1024


def _meta(doc: dict) -> dict:
    return {
        "id": doc["id"],
        "title": (doc.get("title") or "")[:120],
        "createdAt": doc.get("createdAt") or 0,
        "updatedAt": doc.get("updatedAt") or 0,
        "count": len(doc.get("entries") or []),
    }


class LocalStore:
    name = "local"

    def __init__(self, root: str):
        self.root = root
        self._lock = threading.Lock()
        os.makedirs(root, exist_ok=True)

    def _dir(self, user: str) -> str:
        d = os.path.join(self.root, user)
        os.makedirs(d, exist_ok=True)
        return d

    def _read(self, path: str):
        try:
            with open(path, encoding="utf-8") as fh:
                return json.load(fh)
        except FileNotFoundError:
            return None

    def _write(self, path: str, obj) -> None:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(obj, fh, ensure_ascii=False)
        os.replace(tmp, path)

    def list(self, user: str) -> list[dict]:
        idx = self._read(os.path.join(self._dir(user), "index.json")) or {}
        return sorted(idx.values(), key=lambda m: -(m.get("updatedAt") or 0))

    def get(self, user: str, cid: str):
        return self._read(os.path.join(self._dir(user), cid + ".json"))

    def put(self, user: str, doc: dict) -> dict:
        with self._lock:
            d = self._dir(user)
            self._write(os.path.join(d, doc["id"] + ".json"), doc)
            ip = os.path.join(d, "index.json")
            idx = self._read(ip) or {}
            idx[doc["id"]] = _meta(doc)
            self._write(ip, idx)
        return _meta(doc)

    def delete(self, user: str, cid: str) -> None:
        with self._lock:
            d = self._dir(user)
            try:
                os.remove(os.path.join(d, cid + ".json"))
            except FileNotFoundError:
                pass
            ip = os.path.join(d, "index.json")
            idx = self._read(ip) or {}
            if idx.pop(cid, None) is not None:
                self._write(ip, idx)


class SupabaseStore:
    name = "supabase"

    def __init__(self, url: str, key: str, bucket: str = "tarjem"):
        self.base = url.rstrip("/") + "/storage/v1"
        self.bucket = bucket
        self.h = {"apikey": key, "Authorization": f"Bearer {key}"}
        self._lock = threading.Lock()
        self._ensure_bucket()

    def _ensure_bucket(self) -> None:
        try:
            r = requests.post(
                f"{self.base}/bucket",
                headers=self.h,
                json={"id": self.bucket, "name": self.bucket, "public": False},
                timeout=20,
            )
            if r.status_code not in (200, 201, 409) and "already exists" not in r.text:
                log.warning("bucket create returned %s: %s", r.status_code, r.text[:200])
        except Exception as e:  # noqa: BLE001
            log.warning("bucket check failed: %s", e)

    def _path(self, user: str, name: str) -> str:
        return f"{self.bucket}/{user}/{name}"

    def _read(self, user: str, name: str):
        r = requests.get(f"{self.base}/object/{self._path(user, name)}", headers=self.h, timeout=30)
        if r.status_code == 404 or (r.status_code == 400 and "not_found" in r.text.lower()):
            return None
        r.raise_for_status()
        return r.json()

    def _write(self, user: str, name: str, obj) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        h = dict(self.h, **{"Content-Type": "application/json", "x-upsert": "true"})
        r = requests.post(f"{self.base}/object/{self._path(user, name)}", headers=h, data=body, timeout=30)
        if r.status_code in (400, 409):  # exists and upsert header ignored on some versions
            r = requests.put(f"{self.base}/object/{self._path(user, name)}", headers=h, data=body, timeout=30)
        r.raise_for_status()

    def list(self, user: str) -> list[dict]:
        idx = self._read(user, "index.json") or {}
        return sorted(idx.values(), key=lambda m: -(m.get("updatedAt") or 0))

    def get(self, user: str, cid: str):
        return self._read(user, cid + ".json")

    def put(self, user: str, doc: dict) -> dict:
        with self._lock:
            self._write(user, doc["id"] + ".json", doc)
            idx = self._read(user, "index.json") or {}
            idx[doc["id"]] = _meta(doc)
            self._write(user, "index.json", idx)
        return _meta(doc)

    def delete(self, user: str, cid: str) -> None:
        with self._lock:
            requests.delete(
                f"{self.base}/object/{self.bucket}",
                headers=self.h,
                json={"prefixes": [f"{user}/{cid}.json"]},
                timeout=30,
            )
            idx = self._read(user, "index.json") or {}
            if idx.pop(cid, None) is not None:
                self._write(user, "index.json", idx)


def make_store(base_dir: str):
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if url and key:
        try:
            s = SupabaseStore(url, key, os.environ.get("SUPABASE_BUCKET", "tarjem"))
            log.info("conversation store: supabase bucket %s", s.bucket)
            return s
        except Exception as e:  # noqa: BLE001
            log.warning("supabase store unavailable (%s); falling back to local files", e)
    root = os.environ.get("DATA_DIR") or os.path.join(base_dir, "data")
    log.info("conversation store: local files in %s", root)
    return LocalStore(root)


def validate_doc(doc: dict, cid: str) -> dict:
    """Coerce an incoming conversation document to a safe, bounded shape."""
    if not isinstance(doc, dict):
        raise ValueError("document must be an object")
    entries = doc.get("entries") or []
    if not isinstance(entries, list):
        raise ValueError("entries must be a list")
    clean = []
    for e in entries[:2000]:
        if not isinstance(e, dict):
            continue
        clean.append({
            "at": int(e.get("at") or 0),
            "lang": str(e.get("lang") or "")[:5],
            "target": str(e.get("target") or "")[:5],
            "text": str(e.get("text") or "")[:4000],
            "translation": str(e.get("translation") or "")[:4000],
        })
    now = int(time.time() * 1000)
    out = {
        "id": cid,
        "title": str(doc.get("title") or "")[:120],
        "createdAt": int(doc.get("createdAt") or now),
        "updatedAt": int(doc.get("updatedAt") or now),
        "entries": clean,
    }
    if len(json.dumps(out, ensure_ascii=False)) > MAX_DOC_BYTES:
        raise ValueError("conversation too large")
    return out
