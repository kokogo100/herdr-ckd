"""DuckDuckGo 검색 (ddgs). AutoInvest의 방식과 같다: news 실패 시 text로 대체.

사용: python ddgs_search.py "검색어" 5 [news|text]
결과: [{"title", "summary", "url", "published_at", "source"}] JSON
"""
import json
import sys

from ddgs import DDGS


def main() -> None:
    query = sys.argv[1]
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    kind = sys.argv[3] if len(sys.argv) > 3 else "text"
    d = DDGS()
    rows = []
    if kind == "news":
        try:
            rows = list(d.news(query, max_results=n) or [])
        except Exception:
            rows = []
    if not rows:
        rows = list(d.text(query, max_results=n) or [])
    out = [
        {
            "title": r.get("title", ""),
            "summary": r.get("body", ""),
            "url": r.get("url") or r.get("href") or "",
            "published_at": r.get("date", ""),
            "source": "ddg",
        }
        for r in rows
    ]
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
