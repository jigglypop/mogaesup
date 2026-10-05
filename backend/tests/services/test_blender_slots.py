"""How many Blender workers run at once: BLENDER_CONCURRENCY, held to what the machine's memory fits."""
from src.services.avatar_factory import blender_slots

GIB = 2**30


def test_the_studio_instance_runs_one_blender_at_a_time():
    # The t3.large reports 7.6 GiB; two workers of 3.6 GB each were killed for memory there.
    assert blender_slots('2', int(7.6*GIB)) == 1
    assert blender_slots('4', int(7.6*GIB)) == 1


def test_a_larger_machine_keeps_the_requested_count():
    assert blender_slots('2', 16*GIB) == 2
    assert blender_slots('3', 16*GIB) == 3
    assert blender_slots('8', 16*GIB) == 3


def test_at_least_one_worker_and_the_default_of_two():
    assert blender_slots('0', 32*GIB) == 1
    assert blender_slots('', 32*GIB) == 2
    assert blender_slots('2', 2*GIB) == 1
