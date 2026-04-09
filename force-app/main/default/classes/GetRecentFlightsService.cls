/**
 * @description Returns recent flights for a SkyMiles member with miles credit status.
 * Used by the voice agent — returns a CONCISE voice-friendly summary, not a verbose list.
 */
public without sharing class GetRecentFlightsService {

    public class Request {
        @InvocableVariable(required=true label='SkyMiles Number' description='The customer SkyMiles membership number')
        public String skymilesNumber;

        @InvocableVariable(required=false label='Days Back' description='Number of days to look back for flights. Default 30.')
        public Integer daysBack;
    }

    public class Response {
        @InvocableVariable
        public Boolean success;

        @InvocableVariable
        public String flightList;

        @InvocableVariable
        public Integer flightCount;

        @InvocableVariable
        public String message;
    }

    @InvocableMethod(
        label='Get Recent Flights'
        description='Retrieves recently flown flights for a SkyMiles member, showing miles credit status for each'
    )
    public static List<Response> execute(List<Request> requests) {
        List<Response> responses = new List<Response>();

        for (Request request : requests) {
            Response response = new Response();

            try {
                if (String.isBlank(request.skymilesNumber)) {
                    response.success = false;
                    response.message = 'SkyMiles number is required';
                    responses.add(response);
                    continue;
                }

                Integer lookBack = (request.daysBack != null && request.daysBack > 0) ? request.daysBack : 30;
                Date cutoffDate = Date.today().addDays(-lookBack);

                // Find the loyalty member by membership number
                List<LoyaltyProgramMember> members = [
                    SELECT Id, MembershipNumber, Contact.Name
                    FROM LoyaltyProgramMember
                    WHERE MembershipNumber = :request.skymilesNumber
                    LIMIT 1
                ];

                if (members.isEmpty()) {
                    response.success = false;
                    response.message = 'No SkyMiles member found with number: ' + request.skymilesNumber;
                    responses.add(response);
                    continue;
                }

                LoyaltyProgramMember member = members[0];

                // Query recent bookings with flight details
                List<Booking__c> bookings = [
                    SELECT Id, PNR__c, Seat__c, Cabin__c, Status__c,
                           Miles_Credited__c, Miles_Eligible__c,
                           Flight__r.Flight_Number__c, Flight__r.Origin__c,
                           Flight__r.Origin_City__c, Flight__r.Destination__c,
                           Flight__r.Destination_City__c, Flight__r.Departure__c,
                           Flight__r.Status__c
                    FROM Booking__c
                    WHERE Loyalty_Member__c = :member.Id
                    AND Flight__r.Departure__c >= :cutoffDate
                    AND Status__c IN ('Confirmed', 'Checked In', 'Boarded')
                    ORDER BY Flight__r.Departure__c DESC
                    LIMIT 10
                ];

                if (bookings.isEmpty()) {
                    response.success = true;
                    response.flightCount = 0;
                    response.flightList = '';
                    response.message = 'No recent flights found in the last ' + lookBack + ' days';
                } else {
                    // Build a CONCISE voice-friendly summary instead of a verbose list
                    Integer credited = 0;
                    Integer pending = 0;
                    Integer totalEligibleMiles = 0;
                    List<String> pendingRoutes = new List<String>();

                    for (Booking__c booking : bookings) {
                        if (booking.Miles_Credited__c) {
                            credited++;
                        } else {
                            pending++;
                            // Track pending flight routes for brief mention
                            String route = booking.Flight__r.Origin_City__c + ' to ' + booking.Flight__r.Destination_City__c;
                            pendingRoutes.add(route);
                            if (booking.Miles_Eligible__c != null) {
                                totalEligibleMiles += booking.Miles_Eligible__c.intValue();
                            }
                        }
                    }

                    // Build concise summary string
                    String summary = credited + ' of ' + bookings.size() + ' flights have miles credited.';
                    if (pending > 0) {
                        summary += ' ' + pending + ' flight' + (pending > 1 ? 's are' : ' is') + ' still pending';
                        if (!pendingRoutes.isEmpty()) {
                            // Only mention first pending route to keep it brief
                            summary += ' — ' + pendingRoutes[0];
                        }
                        if (totalEligibleMiles > 0) {
                            summary += ' (' + String.valueOf(totalEligibleMiles) + ' miles eligible)';
                        }
                        summary += '.';
                    }

                    response.success = true;
                    response.flightCount = bookings.size();
                    response.flightList = summary;
                    response.message = 'Found ' + bookings.size() + ' recent flights for ' + member.Contact.Name;
                }

            } catch (Exception e) {
                response.success = false;
                response.message = 'Error retrieving flights: ' + e.getMessage();
            }

            responses.add(response);
        }

        return responses;
    }
}
