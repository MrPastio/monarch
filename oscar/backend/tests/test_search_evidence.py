import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from oscar_agent.search import (
    RawSearchResult,
    has_recency_signal,
    iso_date,
    mentions_subject,
    normalize_result_url,
    rank_search_results,
    select_passages,
)


def test_passages_follow_the_question_not_the_page_head():
    menu = "Главная. Курсы. Кредиты. Вклады. Ипотека. Новости. Войти. " * 30
    fact = "Курс евро к доллару на 4 октября составляет 1,1712 по данным биржи."
    tail = "Подписывайтесь на рассылку и читайте нас в соцсетях. " * 30
    passages = select_passages(f"{menu} {fact} {tail}", "курс евро к доллару сегодня", 600)
    assert "1,1712" in passages
    assert len(passages) <= 600


def test_short_page_is_kept_whole():
    assert select_passages("Короткая страница.", "что угодно", 600) == "Короткая страница."


def test_passages_keep_page_order_and_mark_gaps():
    text = " ".join([
        "Alpha launch happened on Monday.",
        *(["Unrelated filler sentence about gardening tools."] * 40),
        "The Alpha launch carried twenty satellites.",
    ])
    passages = select_passages(text, "Alpha launch", 900)
    assert passages.index("Monday") < passages.index("twenty")
    assert "…" in passages


def test_iso_date_accepts_only_real_dates():
    assert iso_date("2026-10-04T10:00:00+00:00") == "2026-10-04"
    assert iso_date("Opinion4 h") == ""
    assert iso_date("2026-13-40") == ""
    assert iso_date(None) == ""


def test_live_values_are_not_sent_to_the_news_index():
    assert has_recency_signal("последние новости SpaceX") is True
    assert has_recency_signal("OpenAI news") is True
    assert has_recency_signal("latest SpaceX launch") is True
    assert has_recency_signal("курс евро к доллару сегодня") is False
    assert has_recency_signal("последний курс биткоина") is False
    assert has_recency_signal("какая погода сегодня в Варне") is False


def test_news_without_the_subject_is_dropped():
    query = "последние новости SpaceX"
    unrelated = RawSearchResult(title="Обновлённый Kia K5 начали продавать", url="https://x.example/kia", snippet="Цены")
    related = RawSearchResult(title="SpaceX запустила Starship", url="https://x.example/ss", snippet="")
    assert mentions_subject(unrelated, query) is False
    assert mentions_subject(related, query) is True


def test_ad_redirects_are_not_results():
    assert normalize_result_url("https://www.bing.com/aclick?ld=abc&u=xyz") == ""
    assert normalize_result_url("https://duckduckgo.com/y.js?ad_domain=shop") == ""
    assert normalize_result_url("https://www.bing.com/search?q=x") == "https://www.bing.com/search?q=x"


def test_front_pages_rank_below_articles_for_news():
    results = [
        RawSearchResult(title="OpenAI", url="https://openai.com/", snippet="OpenAI news"),
        RawSearchResult(title="OpenAI News", url="https://openai.com/news/", snippet="OpenAI news"),
        RawSearchResult(title="OpenAI safety lead quits", url="https://press.example/2026/10/openai-safety", snippet="OpenAI news"),
    ]
    ranked = rank_search_results(results, "OpenAI news")
    assert ranked[0].url == "https://press.example/2026/10/openai-safety"


def test_official_product_page_still_wins_outside_news():
    results = [
        RawSearchResult(title="GPT pricing review", url="https://blog.example/gpt-pricing", snippet="OpenAI pricing"),
        RawSearchResult(title="Pricing", url="https://openai.com/pricing", snippet="OpenAI pricing"),
    ]
    assert rank_search_results(results, "OpenAI pricing")[0].url == "https://openai.com/pricing"


def test_branch_results_must_name_the_subject_of_the_question():
    from oscar_agent.search import named_subjects, on_subject
    question = "Проведи глубокое исследование: что сейчас происходит со Starship от SpaceX?"
    assert {"starsh", "spacex"} <= named_subjects(question)
    psychology = RawSearchResult(title="Учимся спокойно принимать замечания", url="https://mag.example/kritika", snippet="Критика на работе")
    wiki = RawSearchResult(title="Starship", url="https://ru.wikipedia.org/wiki/SpaceX_Starship", snippet="")
    assert on_subject([psychology, wiki], question) == [wiki]
    # Nothing names it (another script or spelling): keep the results rather than answer from nothing.
    assert on_subject([psychology], question) == [psychology]
    # A question without names is not filtered.
    assert on_subject([psychology], "как научиться спокойно принимать критику") == [psychology]
