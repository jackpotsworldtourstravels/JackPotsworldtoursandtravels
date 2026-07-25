from sqlalchemy import text
from sqlalchemy.orm import Session


def generate_report(
    db: Session,
    partner_id: int,
    partner_user_id: int,
    request_date_from: str | None,
    request_date_to: str | None,
    travel_date_from: str | None,
    travel_date_to: str | None,
    passenger_name: str | None,
    service_request_number: str | None,
    sector_departure: str | None,
    sector_arrival: str | None,
    export_format: str,
) -> list[dict]:
    rows = db.execute(
        text("""
            SELECT * FROM sp_generate_report(
                :partner_id, :partner_user_id, :request_date_from, :request_date_to,
                :travel_date_from, :travel_date_to, :passenger_name, :service_request_number,
                :sector_departure, :sector_arrival, :export_format
            )
        """),
        {
            "partner_id": partner_id, "partner_user_id": partner_user_id,
            "request_date_from": request_date_from, "request_date_to": request_date_to,
            "travel_date_from": travel_date_from, "travel_date_to": travel_date_to,
            "passenger_name": passenger_name, "service_request_number": service_request_number,
            "sector_departure": sector_departure, "sector_arrival": sector_arrival,
            "export_format": export_format,
        },
    ).mappings().all()
    db.commit()  # sp_generate_report also writes to report_generation_log
    return [dict(r) for r in rows]
