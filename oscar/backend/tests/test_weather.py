from oscar_agent.weather import extract_place, place_candidates, requested_day


def test_extracts_the_named_place_before_time_words():
    assert extract_place("Какая погода в Варне на завтра?") == "Варне"
    assert extract_place("Прогноз погоды для Софии на послезавтра") == "Софии"
    assert extract_place("weather in Varna tomorrow") == "Varna"
    assert extract_place("погода в Нью Йорке сегодня") == "Нью Йорке"
    assert extract_place("какая погода завтра?") is None
    assert extract_place("погода в городе") is None


def test_locative_case_yields_the_nominative_candidates():
    assert "Варна" in place_candidates("Варне")
    assert "София" in place_candidates("Софии")
    assert "Москва" in place_candidates("Москве")
    assert "Киев" in place_candidates("Киеве")
    assert place_candidates("Varna") == ["Varna"]


def test_requested_day():
    assert requested_day("погода в Варне на завтра") == 1
    assert requested_day("погода в Варне послезавтра") == 2
    assert requested_day("weather in Varna tomorrow") == 1
    assert requested_day("погода в Варне") == 0
