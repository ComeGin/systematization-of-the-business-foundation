"""OpenSEO のツールの許可リスト（無料の参照系だけ）。

この表が、音声エージェントから OpenSEO に送ってよいツールの**正本**である
（ADR-33。AA-03 の 2.4 は Claude のエージェント定義の許可リストで、こちらはコードの許可リスト）。

OpenSEO は ``ACCESS_LEVEL`` を持たず、``local_noauth`` で全ツールを公開している（ADR-10）。
そのため「登録しない」をクライアント側で行う。

- ``MCPServerHTTP(allowed_tools=MODEL_TOOLS)`` でモデルに見せるツールを絞る（W2）。
- ``OpenSeoClient.call`` は ``ALLOWED_TOOLS`` に無い名前を送らずに例外にする（W1）。

費用の判定は OpenSEO の description の文言（``Charges credits``）による（spec の C7）。
GSC・GA4 のツールは DataForSEO を使わないので、OpenSEO のクレジットを使わない。
GA4 の Data API の割り当て（quota）は使うので、呼び出しの回数は ``max_tool_calls`` で抑える（D11）。

**載せないツールと理由**（足すときは ADR-33 を改め、理由をここに書く）:

- 費用の出るもの（DataForSEO。1 回ごと・ページ送りごとに課金される）:
  ``research_keywords`` / ``get_keyword_metrics`` / ``get_domain_keyword_suggestions`` /
  ``get_serp_results`` / ``find_serp_competitors`` / ``get_domain_overview`` /
  ``get_ranked_keywords`` / ``get_backlinks_overview`` / ``get_backlinks_profile`` /
  ローカル SEO 系（``get_local_*`` / ``search_local_businesses`` / ``get_business_*`` /
  ``get_google_business_questions`` / ``list_business_categories``）。
  音声の対話ではモデルが呼ぶ回数を人が見積もれないため、無料のものだけにする（spec の 1 節「失敗とは」）。
- 継続課金・実行課金を生むもの: ``create_rank_tracker`` / ``add_rank_tracking_keywords`` /
  ``run_rank_tracker`` / ``estimate_rank_tracker_cost`` / ``remove_rank_tracking_keywords``。
  ランク追跡の設定は R2 の承認（BA-05）。
- 書き込むもの: ``save_keywords`` / ``update_project_context`` / ``create_project``。
  参照だけにして承認ゲート（BA-05）に触れない（D3）。
- 任意の URL を監査できるもの: ``run_site_audit``。自サイト以外の監査は禁止（BA-05）だが、引数を縛れない。
- 保存済みの監査・順位の参照（``get_audit_*`` / ``get_rank_tracker``）: 無料だが、BI の対話の範囲（GSC・GA4）の外。
  夜の観測（seo-auditor）が E-12 に残している。
- ``list_saved_keywords``: 無料だが、キーワードの採否は E-01（Strapi）が正本で、二重の正本を話さない。
- ``get_google_analytics_ecommerce_performance`` / ``get_google_analytics_site_search``:
  無料だが、EC とサイト内検索の計測をしていない（DA-02 の指標に無い）。
- ``whoami``: 認証のないローカルでは意味を持たない。
- ``list_projects``: 無料だが、モデルには見せない。projectId はセッションの開始時にコードで決める（D2）。
  ``OpenSeoClient.resolve_project_id`` だけが使う。
"""

from __future__ import annotations

MODEL_TOOLS: tuple[str, ...] = (
    # Search Console（自分のプロパティのデータ。計量されない）
    "get_search_console_performance",
    "inspect_urls",
    # GA4（OpenSEO のクレジットを使わない。GA4 の Data API の割り当ては使う）
    "get_google_analytics_organic_overview",
    "get_google_analytics_organic_landing_pages",
    "get_google_analytics_page_performance",
    "get_google_analytics_traffic_acquisition",
    "get_google_analytics_key_events",
    "get_google_analytics_audience_breakdown",
    "get_google_analytics_measurement_health",
    # GSC（順位 4〜20 位のページ）と GA4（自然検索の LP）の結合
    "get_search_opportunities",
    # プロジェクトの記憶（事業の概要・競合・重要なページ）を読むだけ
    "get_project_context",
)
"""モデルに見せる 11 本（spec の D3）。"""

INTERNAL_TOOLS: tuple[str, ...] = ("list_projects",)
"""コードだけが呼ぶツール（モデルには見せない）。"""

ALLOWED_TOOLS: frozenset[str] = frozenset(MODEL_TOOLS + INTERNAL_TOOLS)
"""OpenSEO に送ってよいツールのすべて。"""
