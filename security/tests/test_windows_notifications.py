from threading import Event
from monarch_security.windows_notifications import NotificationChannel


def test_burst_uses_one_presenter_and_one_bounded_summary():
    entered, release, summary = Event(), Event(), Event()
    instances, calls = [], []
    class Balloon:
        def __init__(self): instances.append(self)
        def show(self, title, body, seconds):
            calls.append((title, body, seconds))
            if len(calls) == 1:
                entered.set()
                assert release.wait(3)
            else: summary.set()
        def hide(self): pass
        def close(self): self.closed = True
    channel = NotificationChannel(Balloon)
    try:
        assert channel.submit('first', 'event', 7)
        assert entered.wait(2)
        for i in range(1000): channel.submit(str(i), f'event {i}', 999)
        assert len(instances) == 1
        assert channel._pending == ('999', 'event 999', 10.0)
        release.set()
        assert summary.wait(2)
    finally:
        release.set()
        channel.close()
    assert len(calls) == 2
    assert '1000' in calls[1][0]
    assert 'event 999' in calls[1][1]
    assert instances[0].closed
    assert channel.submit('after close', '', 1) is False


def test_delivery_failure_cleans_native_resources():
    closed = Event()
    class Balloon:
        def show(self, *args): raise OSError('native failure')
        def hide(self): pass
        def close(self): closed.set()
    channel = NotificationChannel(Balloon)
    channel.submit('title', 'body', 1)
    assert closed.wait(2)
    channel.close()
    assert channel.last_error == 'OSError'
