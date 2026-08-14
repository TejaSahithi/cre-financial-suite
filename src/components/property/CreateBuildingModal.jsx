import React, { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Building2, Loader2 } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BuildingService } from "@/services/api";
import { createNotificationsForEvent } from "@/services/notificationService";
import { createPageUrl } from "@/utils";
import { toast } from "sonner";

export default function CreateBuildingModal({ isOpen, onClose, properties = [], buildingToEdit = null }) {
  const queryClient = useQueryClient();
  const [usePropertyAddress, setUsePropertyAddress] = useState(true);
  const isEditing = !!buildingToEdit;

  const [form, setForm] = useState({
    name: "",
    property_id: properties[0]?.id || "",
    address: "",
    total_sf: "",
    floors: "1",
    year_built: "",
  });

  const selectedProperty = useMemo(
    () => properties.find((property) => property.id === form.property_id) || null,
    [properties, form.property_id]
  );
  const selectedPropertyAddress = [
    selectedProperty?.address,
    selectedProperty?.city,
    selectedProperty?.state,
    selectedProperty?.zip,
  ].filter(Boolean).join(", ");

  useEffect(() => {
    if (usePropertyAddress && selectedProperty?.address && !isEditing) {
      setForm((current) => ({ ...current, address: selectedProperty.address }));
    }
  }, [usePropertyAddress, selectedProperty?.address, isEditing]);

  useEffect(() => {
    if (!isOpen) return;
    if (buildingToEdit) {
      setForm({
        name: buildingToEdit.name || "",
        property_id: buildingToEdit.property_id || properties[0]?.id || "",
        address: buildingToEdit.address || "",
        total_sf: buildingToEdit.total_sf ? String(buildingToEdit.total_sf) : "",
        floors: buildingToEdit.floors ? String(buildingToEdit.floors) : "1",
        year_built: buildingToEdit.year_built ? String(buildingToEdit.year_built) : "",
      });
      setUsePropertyAddress(!buildingToEdit.address || buildingToEdit.address === selectedProperty?.address);
    } else {
      setForm({
        name: "",
        property_id: properties[0]?.id || "",
        address: "",
        total_sf: "",
        floors: "1",
        year_built: "",
      });
      setUsePropertyAddress(true);
    }
  }, [isOpen, buildingToEdit, properties]);

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      if (isEditing) {
        return BuildingService.update(buildingToEdit.id, data);
      }
      const created = await BuildingService.create(data);
      const property = properties.find((item) => item.id === (created?.property_id || data.property_id));

      createNotificationsForEvent({
        org_id: created?.org_id || property?.org_id || data.org_id,
        event_type: "building.created",
        entity_type: "building",
        entity_id: created?.id,
        entity_label: created?.name || data.name,
        portfolio_id: property?.portfolio_id || null,
        property_id: created?.property_id || data.property_id,
        action_url: createPageUrl("BuildingsUnits"),
        metadata: {
          source: "building_create_modal",
          building_name: created?.name || data.name,
          property_name: property?.name || null,
        },
      }).catch((error) => {
        console.warn("[CreateBuildingModal] notification event failed:", error?.message || error);
      });

      return created;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bu-buildings"] });
      queryClient.invalidateQueries({ queryKey: ["Building"] });
      toast.success(isEditing ? "Building updated successfully." : "Building created successfully.");
      onClose();
      setUsePropertyAddress(true);
      setForm({ name: "", property_id: properties[0]?.id || "", address: "", total_sf: "", floors: "1", year_built: "" });
    },
    onError: (err) => {
      toast.error(`Failed to ${isEditing ? 'update' : 'create'} building: ${err.message}`);
    },
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.name || !form.property_id) return;
    saveMutation.mutate({
      ...form,
      total_sf: parseInt(form.total_sf) || 0,
      floors: parseInt(form.floors) || 1,
      year_built: parseInt(form.year_built) || null,
      status: "active",
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={(v) => { if(!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="w-5 h-5 text-blue-600" />
            {isEditing ? "Edit Building" : "Add New Building"}
          </DialogTitle>
          <DialogDescription>
            {isEditing ? "Update details for this building structure." : "Create a new building structure within an existing property."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="name">Building Name *</Label>
            <Input 
              id="name" 
              placeholder="e.g. Building A" 
              value={form.name} 
              onChange={e => setForm({...form, name: e.target.value})} 
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="property">Property *</Label>
            <Select 
              value={form.property_id} 
              onValueChange={v => {
                const nextProperty = properties.find((property) => property.id === v);
                setForm((current) => ({
                  ...current,
                  property_id: v,
                  address: usePropertyAddress && nextProperty?.address ? nextProperty.address : current.address,
                }));
              }}
            >
              <SelectTrigger id="property">
                <SelectValue placeholder="Select property..." />
              </SelectTrigger>
              <SelectContent>
                {properties.map(p => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="address">Address (Optional)</Label>
            {selectedPropertyAddress && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={usePropertyAddress}
                    onCheckedChange={(checked) => {
                      const useSame = checked === true;
                      setUsePropertyAddress(useSame);
                      if (useSame && selectedProperty?.address) {
                        setForm((current) => ({ ...current, address: selectedProperty.address }));
                      }
                    }}
                  />
                  <span>Use property address</span>
                </label>
                <span className="truncate text-slate-400">{selectedPropertyAddress}</span>
              </div>
            )}
            <Input 
              id="address" 
              placeholder="If different from property address" 
              value={form.address} 
              onChange={e => {
                const nextAddress = e.target.value;
                setForm({...form, address: nextAddress});
                if (selectedProperty?.address && nextAddress !== selectedProperty.address) {
                  setUsePropertyAddress(false);
                }
              }} 
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="total_sf">Total SQ FT</Label>
              <Input 
                id="total_sf" 
                type="number" 
                placeholder="0" 
                value={form.total_sf} 
                onChange={e => setForm({...form, total_sf: e.target.value})} 
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="floors">Floors</Label>
              <Input 
                id="floors" 
                type="number" 
                min="1" 
                value={form.floors} 
                onChange={e => setForm({...form, floors: e.target.value})} 
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="year_built">Year Built</Label>
            <Input 
              id="year_built" 
              type="number" 
              placeholder="e.g. 2020" 
              value={form.year_built} 
              onChange={e => setForm({...form, year_built: e.target.value})} 
            />
          </div>

          <DialogFooter className="pt-4 flex !justify-between items-center sm:!justify-between">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button 
              type="submit" 
              className="bg-blue-600 hover:bg-blue-700 min-w-[120px]"
              disabled={!form.name || !form.property_id || saveMutation.isPending}
            >
              {saveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              {isEditing ? "Save Changes" : "Create Building"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
