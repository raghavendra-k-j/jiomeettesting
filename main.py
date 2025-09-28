from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Dict, Optional, Set
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from uuid import uuid4

import httpx
import jwt
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field


load_dotenv()


logger = logging.getLogger("doctor_patient_demo")
logging.basicConfig(level=logging.INFO)


class Provider(str, Enum):
	JIOMEET = "jiomeet"
	MOCK = "mock"


class MeetingInfo(BaseModel):
	provider: Provider
	base_url: str = Field(description="Meeting link returned by the provider")
	doctor_url: str = Field(description="Auto-join link for the doctor")
	patient_url: str = Field(description="Auto-join link for the patient")
	created_at: datetime = Field(description="Timestamp when meeting was created")
	host_token: Optional[str] = Field(
		default=None, description="Token required for host privileges, if any"
	)


class AppointmentState(BaseModel):
	appointment_id: str
	doctor_name: str
	patient_name: str
	created_at: datetime
	meeting: Optional[MeetingInfo] = None
	last_error: Optional[str] = None


class AppointmentCreateRequest(BaseModel):
	doctor_name: str = Field(..., min_length=1, description="Doctor display name")
	patient_name: Optional[str] = Field(
		default=None, description="Optional patient display name"
	)


class AppointmentCreateResponse(BaseModel):
	appointment: AppointmentState


class MeetingCreateResponse(BaseModel):
	appointment: AppointmentState


class AppointmentResponse(BaseModel):
	appointment: Optional[AppointmentState]


class MessageResponse(BaseModel):
	message: str


class AppointmentStore:
	def __init__(self) -> None:
		self._lock = asyncio.Lock()
		self._appointment: Optional[AppointmentState] = None

	async def get(self) -> Optional[AppointmentState]:
		async with self._lock:
			return self._appointment

	async def create(self, state: AppointmentState) -> None:
		async with self._lock:
			if self._appointment is not None:
				raise ValueError("An appointment already exists")
			self._appointment = state

	async def update(self, meeting: MeetingInfo) -> AppointmentState:
		async with self._lock:
			if self._appointment is None:
				raise ValueError("No appointment to update")
			self._appointment = self._appointment.copy(update={"meeting": meeting, "last_error": None})
			return self._appointment

	async def set_error(self, message: str) -> None:
		async with self._lock:
			if self._appointment is not None:
				self._appointment = self._appointment.copy(update={"last_error": message})

	async def delete(self) -> None:
		async with self._lock:
			self._appointment = None


class JioMeetClient:
	def __init__(
		self,
		app_id: Optional[str],
		app_secret: Optional[str],
		subdomain: Optional[str],
		mock_mode: bool = False,
	) -> None:
		self.app_id = app_id
		self.app_secret = app_secret
		self.subdomain = subdomain
		self.mock_mode = mock_mode or not all([app_id, app_secret, subdomain])

		if self.mock_mode:
			logger.warning("Running in mock JioMeet mode; no external API calls will be made.")

	async def create_meeting(
		self,
		doctor_name: str,
		patient_name: str,
		description: str,
	) -> MeetingInfo:
		if self.mock_mode:
			return self._create_mock_meeting(doctor_name, patient_name)

		token = self._generate_token()
		if token is None:
			raise RuntimeError("Unable to generate JioMeet token")

		url = f"https://{self.subdomain}/api/platform/v1/room"

		payload = {
			"name": doctor_name,
			"title": f"Appointment with {patient_name}",
			"description": description,
			"hostToken": True,
		}

		headers = {
			"Authorization": token,
			"Content-Type": "application/json",
			"Accept": "application/json",
		}

		async with httpx.AsyncClient(timeout=15) as client:
			response = await client.post(url, json=payload, headers=headers)

		if response.status_code != status.HTTP_200_OK:
			logger.error("JioMeet meeting creation failed: %s", response.text)
			raise RuntimeError(f"JioMeet API error {response.status_code}: {response.text}")

		data = response.json()
		base_url = data.get("meetingLink") or data.get("guestMeetingLink")
		if not base_url:
			raise RuntimeError("JioMeet response missing meeting link")

		host_token = data.get("hostToken")
		return self._build_meeting_info(base_url, doctor_name, patient_name, host_token, Provider.JIOMEET)

	def _generate_token(self) -> Optional[str]:
		if not all([self.app_id, self.app_secret]):
			return None

		payload = {
			"app": self.app_id,
			"iss": self.app_id,
			"iat": int(datetime.now(tz=timezone.utc).timestamp()),
			"exp": int((datetime.now(tz=timezone.utc) + timedelta(minutes=5)).timestamp()),
		}

		token = jwt.encode(payload, self.app_secret, algorithm="HS256")
		return token

	def _create_mock_meeting(self, doctor_name: str, patient_name: str) -> MeetingInfo:
		base_host = self.subdomain or "mock.jiomeet.local"
		base_guest_url = f"https://{base_host}/guest"
		meeting_id = uuid4().hex[:10].upper()
		meeting_pin = f"{uuid4().int % 1000000:06d}"
		base_with_params = self._augment_url(
			base_guest_url,
			{"meetingId": meeting_id, "pwd": meeting_pin},
		)
		return self._build_meeting_info(
			base_with_params,
			doctor_name,
			patient_name,
			host_token="mock-host-token",
			provider=Provider.MOCK,
		)

	@staticmethod
	def _build_meeting_info(
		base_url: str,
		doctor_name: str,
		patient_name: str,
		host_token: Optional[str],
		provider: Provider,
	) -> MeetingInfo:
		sanitized_base = JioMeetClient._augment_url(
			base_url,
			{},
			remove_keys={"displayName", "name", "autoJoin", "hostToken"},
		)

		doctor_url = JioMeetClient._augment_url(
			sanitized_base,
			{
				"name": doctor_name,
				"autoJoin": "true",
				"hostToken": host_token,
			},
		)

		patient_url = JioMeetClient._augment_url(
			sanitized_base,
			{
				"name": patient_name,
				"autoJoin": "true",
				"hostToken": None,
			},
		)

		return MeetingInfo(
			provider=provider,
			base_url=sanitized_base,
			doctor_url=doctor_url,
			patient_url=patient_url,
			created_at=datetime.now(tz=timezone.utc),
			host_token=host_token,
		)

	@staticmethod
	def _augment_url(
		base_url: str,
		params: Dict[str, Any],
	remove_keys: Optional[Set[str]] = None,
	) -> str:
		parsed = urlparse(base_url)
		existing = dict(parse_qsl(parsed.query, keep_blank_values=True))

		if remove_keys:
			for key in remove_keys:
				existing.pop(key, None)

		for key, value in params.items():
			if value is None:
				existing.pop(key, None)
			else:
				existing[key] = value

		new_query = urlencode(existing, doseq=True)
		return urlunparse(parsed._replace(query=new_query))


def create_app() -> FastAPI:
	app = FastAPI(title="Doctor-Patient JioMeet Demo")

	templates = Jinja2Templates(directory="templates")
	app.mount("/static", StaticFiles(directory="static"), name="static")

	appointment_store = AppointmentStore()

	jiomeet_client = JioMeetClient(
		app_id=os.getenv("JIOMEET_APP_ID"),
		app_secret=os.getenv("JIOMEET_APP_SECRET"),
		subdomain=os.getenv("JIOMEET_SUBDOMAIN"),
		mock_mode=os.getenv("JIOMEET_MOCK_MODE", "false").lower() in {"1", "true", "yes", "on"},
	)

	default_doctor = os.getenv("DUMMY_DOCTOR_NAME", "Dr. Demo")
	default_patient = os.getenv("DUMMY_PATIENT_NAME", "Patient Demo")

	async def get_store() -> AppointmentStore:
		return appointment_store

	async def get_client() -> JioMeetClient:
		return jiomeet_client

	@app.get("/", response_class=HTMLResponse)
	async def root(request: Request) -> HTMLResponse:
		return templates.TemplateResponse("index.html", {"request": request, "defaults": {"doctor": default_doctor, "patient": default_patient}})

	@app.get("/api/appointment", response_model=AppointmentResponse)
	async def get_appointment(store: AppointmentStore = Depends(get_store)) -> AppointmentResponse:
		appointment = await store.get()
		return AppointmentResponse(appointment=appointment)

	@app.post("/api/appointment", response_model=AppointmentCreateResponse, status_code=status.HTTP_201_CREATED)
	async def create_appointment(
		payload: AppointmentCreateRequest,
		store: AppointmentStore = Depends(get_store),
	) -> AppointmentCreateResponse:
		appointment_id = uuid4().hex
		state = AppointmentState(
			appointment_id=appointment_id,
			doctor_name=payload.doctor_name.strip(),
			patient_name=(payload.patient_name or default_patient).strip(),
			created_at=datetime.now(tz=timezone.utc),
			meeting=None,
			last_error=None,
		)

		try:
			await store.create(state)
		except ValueError as exc:
			raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc

		return AppointmentCreateResponse(appointment=state)

	@app.post("/api/appointment/meeting", response_model=MeetingCreateResponse)
	async def create_meeting(
		store: AppointmentStore = Depends(get_store),
		client: JioMeetClient = Depends(get_client),
	) -> MeetingCreateResponse:
		appointment = await store.get()
		if appointment is None:
			raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No appointment")

		try:
			meeting = await client.create_meeting(
				doctor_name=appointment.doctor_name,
				patient_name=appointment.patient_name,
				description=f"Telehealth visit between {appointment.doctor_name} and {appointment.patient_name}",
			)
		except Exception as exc:
			logger.exception("Failed to create meeting: %s", exc)
			await store.set_error(str(exc))
			raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Unable to create meeting") from exc

		updated = await store.update(meeting)
		return MeetingCreateResponse(appointment=updated)

	@app.delete("/api/appointment", response_model=MessageResponse)
	async def delete_appointment(store: AppointmentStore = Depends(get_store)) -> MessageResponse:
		await store.delete()
		return MessageResponse(message="Appointment deleted")

	return app


app = create_app()

