"""Live sockets obey real account logout/deletion/expiry after their handshake."""

import asyncio
from datetime import timedelta
import importlib
import json
import uuid

import pytest
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

import live_rooms_ws


class SyntheticRoomStore:
    """Test only the account/socket boundary; room persistence has Linux tests."""
    def __init__(self, root):
        self.root = root
        self.root.mkdir(parents=True)
        self.latest_seq = 0
    def get_metadata(self, _room_id, _key):
        return {"latest_seq": self.latest_seq}


class SessionTestService(live_rooms_ws.LiveRoomWebSocketService):
    # Keep the production socket handler, send, watcher and handshake, using
    # inert room operations so Linux-only fsync/flock doesn't hide auth failures
    # on the supported local Windows development environment.
    async def join(self, websocket, room_id, hello, client_ip):
        peer = live_rooms_ws.Peer(websocket, room_id, hello["room_key"], str(uuid.uuid4()), "Reviewer", "blue", ready=True)
        self.rooms[room_id][peer.participant_id] = peer
        await self.send_json(websocket, {"type": "room.ready"})
        return peer
    async def leave(self, peer):
        self.rooms[peer.room_id].pop(peer.participant_id, None)
    async def handle_message(self, peer, message):
        self.store.latest_seq += 1
        await self.send_json(peer.websocket, {"type": "event.committed", "seq": self.store.latest_seq})


@pytest.fixture()
def room_account(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'sessions.db'}")
    import constants
    importlib.reload(constants)
    import models.engine as engine
    importlib.reload(engine)
    import services.auth_store as auth_store
    importlib.reload(auth_store)
    engine.reset_engine_for_tests()
    engine.create_all()
    user = auth_store.create_user("socket@example.test", "password1")
    token = auth_store.create_session(user["id"])
    store = SyntheticRoomStore(tmp_path / "room-files")
    yield store, str(uuid.uuid4()), "synthetic-room-key", user, token
    engine.reset_engine_for_tests()


async def join(socket, key):
    await socket.send(json.dumps({"type": "hello", "protocol": 1, "room_key": key, "name": "Reviewer", "last_seq": 0}))
    ready = json.loads(await asyncio.wait_for(socket.recv(), 3))
    assert ready["type"] == "room.ready"


def invalidate(kind, user, token):
    from services import auth_store
    if kind == "logout":
        auth_store.revoke_session(token)
    elif kind == "account-deletion":
        auth_store.request_deletion(user["id"])
    else:
        from models.engine import session_scope
        from models.auth_session import AuthSession
        from models.job import utcnow
        from sqlalchemy import select
        with session_scope() as session:
            row = session.execute(select(AuthSession).where(AuthSession.user_id == user["id"])).scalar_one()
            row.expires_at = utcnow() - timedelta(seconds=1)


@pytest.mark.parametrize("kind", ["logout", "account-deletion", "expiry"])
def test_idle_recipient_is_disconnected_when_session_becomes_invalid(room_account, monkeypatch, kind):
    store, room_id, key, user, token = room_account
    # Exercise the real periodic watcher quickly, without changing production's interval.
    monkeypatch.setattr(live_rooms_ws, "SESSION_CHECK_INTERVAL_SECONDS", 0.05)

    async def scenario():
        service = SessionTestService(store)
        async with serve(service.handler, "127.0.0.1", 0, process_request=live_rooms_ws.process_request) as server:
            uri = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}/ws/live-rooms/{room_id}"
            async with connect(uri, additional_headers={"Cookie": f"bm_session={token}"}) as socket:
                await join(socket, key)
                invalidate(kind, user, token)
                # No client message is sent: an idle peer must still lose access.
                with pytest.raises(ConnectionClosed) as closed:
                    await asyncio.wait_for(socket.recv(), 3)
                assert closed.value.rcvd.code == 4401
        assert not service.rooms.get(room_id)
    asyncio.run(scenario())


def test_revoked_session_cannot_commit_before_next_periodic_check(room_account, monkeypatch):
    store, room_id, key, user, token = room_account
    monkeypatch.setattr(live_rooms_ws, "SESSION_CHECK_INTERVAL_SECONDS", 60)

    async def scenario():
        service = SessionTestService(store)
        async with serve(service.handler, "127.0.0.1", 0, process_request=live_rooms_ws.process_request) as server:
            uri = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}/ws/live-rooms/{room_id}"
            async with connect(uri, additional_headers={"Cookie": f"bm_session={token}"}) as socket:
                await join(socket, key)
                await socket.send(json.dumps({"type": "chat.add", "event_id": "valid-action"}))
                assert json.loads(await socket.recv())["type"] == "event.committed"
                invalidate("logout", user, token)
                await socket.send(json.dumps({
                    "type": "chat.add", "event_id": "must-not-commit",
                    "payload": {"message": {"id": "denied", "text": "Must not be stored"}},
                }))
                with pytest.raises(ConnectionClosed) as closed:
                    await asyncio.wait_for(socket.recv(), 3)
                assert closed.value.rcvd.code == 4401
        assert store.get_metadata(room_id, key)["latest_seq"] == 1
    asyncio.run(scenario())


def test_auth_failure_blocks_outbound_frames_before_close_finishes(room_account, monkeypatch):
    store, _room_id, _key, _user, _token = room_account
    monkeypatch.setattr(live_rooms_ws.auth_store, "resolve_session", lambda _: None)

    async def scenario():
        class SlowCloseSocket:
            def __init__(self):
                self.sent = []
                self.closing = asyncio.Event()
                self.finish_close = asyncio.Event()
            async def close(self, **_kwargs):
                self.closing.set()
                await self.finish_close.wait()
            async def send(self, message):
                self.sent.append(message)
        socket = SlowCloseSocket()
        service = live_rooms_ws.LiveRoomWebSocketService(store)
        check = asyncio.create_task(service._require_live_session(socket, "revoked"))
        await asyncio.wait_for(socket.closing.wait(), 3)
        await service.send_json(socket, {"type": "event.committed", "secret": "must-not-send"})
        assert socket.sent == []
        socket.finish_close.set()
        assert await check is False
    asyncio.run(scenario())
