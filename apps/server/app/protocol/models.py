from typing import Any, Literal, Optional, Union

from pydantic import BaseModel, Field, field_validator, model_validator


class Rect(BaseModel):
    x: float
    y: float
    w: float = Field(gt=0)
    h: float = Field(gt=0)


class RedactedValue(BaseModel):
    kind: Literal["redacted"]
    ref: str
    pii: str


class TextValue(BaseModel):
    kind: Literal["text"]
    text: str


ValueSlot = Union[RedactedValue, TextValue]


class ElementNode(BaseModel):
    id: int = Field(ge=0)
    role: str
    tag: str
    name: Optional[str] = None
    value: Optional[ValueSlot] = None
    editable: bool
    rect: Rect
    in_viewport: bool = True
    attributes: dict[str, str] = {}


class PiiRef(BaseModel):
    ref: str
    kind: str


class ImageRegion(BaseModel):
    ref: str
    mime: Literal["image/webp"]
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    data_b64: str


class Viewport(BaseModel):
    w: int
    h: int


class ScrollPos(BaseModel):
    x: float = 0
    y: float = 0


class ScreenContext(BaseModel):
    url_skeleton: str
    title: str
    viewport: Viewport
    scroll: ScrollPos = ScrollPos()
    frame_hash: str
    elements: list[ElementNode] = Field(max_length=400)
    pii_refs: list[PiiRef] = []
    redaction_count: int = 0
    image_regions: list[ImageRegion] = []


class ClickAction(BaseModel):
    type: Literal["click"]
    target: int = Field(ge=0)


class FillAction(BaseModel):
    type: Literal["fill"]
    target: int = Field(ge=0)
    ref: Optional[str] = None
    text: Optional[str] = None

    @model_validator(mode="after")
    def _needs_ref_or_text(self) -> "FillAction":
        if self.ref is None and self.text is None:
            raise ValueError("fill requires ref or text")
        return self


class ScrollAction(BaseModel):
    type: Literal["scroll"]
    direction: Literal["up", "down"]
    amount: int = Field(default=600, gt=0, le=5000)


class NavigateAction(BaseModel):
    type: Literal["navigate"]
    url: str

    @field_validator("url")
    @classmethod
    def _http_only(cls, v: str) -> str:
        if not v.lower().startswith(("http://", "https://")):
            raise ValueError("only http(s) navigation allowed")
        return v


class WaitAction(BaseModel):
    type: Literal["wait"]
    ms: int = Field(ge=50, le=10000)


class DoneAction(BaseModel):
    type: Literal["done"]
    summary: str


class FailAction(BaseModel):
    type: Literal["fail"]
    reason: str


AgentAction = Union[
    ClickAction,
    FillAction,
    ScrollAction,
    NavigateAction,
    WaitAction,
    DoneAction,
    FailAction,
]


class Timings(BaseModel):
    extract_ms: float = 0
    redact_ms: float = 0
    serialize_ms: float = 0
    rtt_ms: Optional[float] = None


class ClientHello(BaseModel):
    type: Literal["hello"]
    v: int
    session: str
    caps: dict[str, Any] = {}


class PerceptionMsg(BaseModel):
    type: Literal["perception"]
    seq: int
    task: str
    screen: ScreenContext
    timings: Timings = Timings()


class ActionResultMsg(BaseModel):
    type: Literal["action_result"]
    seq: int
    results: list[dict[str, Any]] = []


ClientMessage = Union[ClientHello, PerceptionMsg, ActionResultMsg]

TERMINAL_ACTIONS = {"done", "fail"}
