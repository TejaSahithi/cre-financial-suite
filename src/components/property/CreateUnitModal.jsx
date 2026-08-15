import React, { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DoorOpen, Loader2 } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UnitService } from "@/services/api";
import { createNotificationsForEvent } from "@/services/notificationService";
import { createPageUrl } from "@/utils";
import { toast } from "sonner";

export default function CreateUnitModal({ isOpen, onClose, buildings = [], unitToEdit = null }) {
  const queryClient = useQueryClient();
  const isEditing = !!unitToEdit;
  const firstBuildingId = buildings[0]?.id || "";
  const buildingById = useMemo(
    () => new Map((buildings || []).map((building) => [building.id, building])),
    [buildings]
  );
  const [form, setForm] = useState({
    unit_id_code: "",
    building_id: firstBuildingId,
    floor: "1",
    square_feet: "",
    unit_type: "office",
    occupancy_status: "vacant",
  });

  useEffect(() => {
    if (!isOpen) return;
    if (unitToEdit) {
      setForm({
        unit_id_code: unitToEdit.unit_number || unitToEdit.unit_id_code || "",
        building_id: unitToEdit.building_id || firstBuildingId,
        floor: unitToEdit.floor ? String(unitToEdit.floor) : "1",
        square_feet: unitToEdit.square_footage || unitToEdit.square_feet ? String(unitToEdit.square_footage || unitToEdit.square_feet) : "",
        unit_type: unitToEdit.unit_type || "office",
        occupancy_status: unitToEdit.occupancy_status || unitToEdit.status || "vacant",
      });
    } else {
      setForm({
        unit_id_code: "",
        building_id: firstBuildingId,
        floor: "1",
        square_feet: "",
        unit_type: "office",
        occupancy_status: "vacant",
      });
    }
  }, [isOpen, unitToEdit, firstBuildingId]);

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      if (isEditing) {
        return UnitService.update(unitToEdit.id, data);
      }
      const created = await UnitService.create(data);
      const building = buildingById.get(created?.building_id || data.building_id) || null;

      createNotificationsForEvent({
        org_id: created?.org_id || building?.org_id || data.org_id,
        event_type: "unit.created",
        entity_type: "unit",
        entity_id: created?.id,
        entity_label: created?.unit_number || data.unit_number,
        portfolio_id: building?.portfolio_id || null,
        property_id: created?.property_id || data.property_id,
        action_url: createPageUrl("BuildingsUnits"),
        metadata: {
          source: "unit_create_modal",
          unit_number: created?.unit_number || data.unit_number,
          building_name: building?.name || null,
        },
      }).catch((error) => {
        console.warn("[CreateUnitModal] notification event failed:", error?.message || error);
      });

      return created;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bu-units"] });
      queryClient.invalidateQueries({ queryKey: ["Unit"] });
      toast.success(isEditing ? "Unit updated successfully." : "Unit created successfully.");
      onClose();
      setForm({
        unit_id_code: "",
        building_id: firstBuildingId,
        floor: "1",
        square_feet: "",
        unit_type: "office",
        occupancy_status: "vacant",
      });
    },
    onError: (err) => {
      toast.error(`Failed to ${isEditing ? 'update' : 'create'} unit: ${err.message}`);
    },
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.unit_id_code || !form.building_id) return;
    const selectedBuilding = buildingById.get(form.building_id) || null;
    const propertyId = selectedBuilding?.property_id || (unitToEdit?.property_id) || null;
    if (!propertyId) {
      toast.error("Selected building is missing its property link.");
      return;
    }
    saveMutation.mutate({
      unit_id_code: form.unit_id_code,
      unit_number: form.unit_id_code,
      property_id: propertyId,
      building_id: form.building_id,
      square_footage: parseInt(form.square_feet, 10) || 0,
      floor: parseInt(form.floor) || 1,
      unit_type: form.unit_type,
      occupancy_status: form.occupancy_status,
      status: form.occupancy_status,
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={(v) => { if(!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <DoorOpen className="w-5 h-5 text-blue-600" />
            {isEditing ? "Edit Unit" : "Add New Unit"}
          </DialogTitle>
          <DialogDescription>
            {isEditing ? "Update details for this unit or suite." : "Specify details for a new unit or suite within a building."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="unit_id_code">Unit / Suite Number *</Label>
            <Input 
              id="unit_id_code" 
              placeholder="e.g. Suite 101" 
              value={form.unit_id_code} 
              onChange={e => setForm({...form, unit_id_code: e.target.value})} 
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="building">Building *</Label>
            <Select 
              value={form.building_id} 
              onValueChange={v => setForm({...form, building_id: v})}
            >
              <SelectTrigger id="building">
                <SelectValue placeholder="Select building..." />
              </SelectTrigger>
              <SelectContent>
                {buildings.map(b => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name || b.building_name || b.building_id_code || "Building"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="floor">Floor</Label>
              <Input 
                id="floor" 
                type="number" 
                min="1" 
                value={form.floor} 
                onChange={e => setForm({...form, floor: e.target.value})} 
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="square_feet">Square Footage</Label>
              <Input 
                id="square_feet" 
                type="number" 
                placeholder="0" 
                value={form.square_feet} 
                onChange={e => setForm({...form, square_feet: e.target.value})} 
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="unit_type">Unit Type</Label>
              <Select 
                value={form.unit_type} 
                onValueChange={v => setForm({...form, unit_type: v})}
              >
                <SelectTrigger id="unit_type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="office">Office</SelectItem>
                  <SelectItem value="retail">Retail</SelectItem>
                  <SelectItem value="industrial">Industrial</SelectItem>
                  <SelectItem value="amenity">Amenity</SelectItem>
                  <SelectItem value="storage">Storage</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="status">Occupancy Status</Label>
              <Select 
                value={form.occupancy_status} 
                onValueChange={v => setForm({...form, occupancy_status: v})}
              >
                <SelectTrigger id="status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="vacant">Vacant</SelectItem>
                  <SelectItem value="leased">Leased</SelectItem>
                  <SelectItem value="occupied">Occupied (Internal)</SelectItem>
                  <SelectItem value="maintenance">Maintenance</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter className="pt-4 flex !justify-between items-center sm:!justify-between">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button 
              type="submit" 
              className="bg-blue-600 hover:bg-blue-700 min-w-[120px]" 
              disabled={!form.unit_id_code || !form.building_id || saveMutation.isPending}
            >
              {saveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              {isEditing ? "Save Changes" : "Create Unit"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
