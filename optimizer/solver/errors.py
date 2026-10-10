"""入力検証エラー。"""


class InvalidArgument(Exception):
    """入力が契約に違反している。fields は 項目名 → 理由。"""

    def __init__(self, fields: dict[str, str]):
        super().__init__("; ".join(f"{k}: {v}" for k, v in fields.items()))
        self.fields = fields
