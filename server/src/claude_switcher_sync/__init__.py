"""Sync server for the Claude Multi-Account Switcher extension.

The server is a per-user namespaced JSON store with TTL locks. It never sees
passphrases, encryption keys, or plaintext OAuth tokens: secret blobs arrive
already encrypted (AES-256-GCM, key derived client-side) and the login
credential is a derived auth key whose sha256 is all we store.
"""

__version__ = "0.1.0"
